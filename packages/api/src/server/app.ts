import { Hono } from "hono";
import type { SpanRepository } from "@usetheo/lens-core";

import {
  parseResourceSpans,
  OtlpParseError,
} from "../otlp/parse-resource-spans.js";
import { spansIngested, logIngest } from "./metrics.js";

/**
 * Build the Hono app for M0. Depends only on the {@link SpanRepository} port
 * (DIP) — the concrete Drizzle adapter is injected by the composition root.
 *
 *  - POST /v1/traces      : OTLP/HTTP JSON ingest (415 on non-JSON, D1)
 *  - GET  /v1/spans/:id    : read one span back (404 when absent)
 */
export function createApp(repo: SpanRepository): Hono {
  const app = new Hono();

  // Fail-loud, fail-clear (Rule 8): any unhandled error (e.g. Postgres
  // unavailable during repo.save/getBySpanId) is logged with context and
  // surfaced as 500 — never a silent partial success.
  app.onError((err, c) => {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "request_failed",
        method: c.req.method,
        path: c.req.path,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return c.json({ error: "internal error" }, 500);
  });

  app.post("/v1/traces", async (c) => {
    const contentType = (c.req.header("content-type") ?? "").toLowerCase();
    if (!contentType.includes("application/json")) {
      return c.json(
        { error: "only application/json is supported in M0" },
        415,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "malformed JSON body" }, 400);
    }

    let toSave;
    try {
      toSave = parseResourceSpans(body);
    } catch (err) {
      if (err instanceof OtlpParseError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    if (toSave.length === 0) {
      return c.json({}, 200);
    }

    await repo.save(toSave);
    spansIngested.add(toSave.length);
    logIngest(toSave.length);
    return c.json({ partialSuccess: {} }, 200);
  });

  app.get("/v1/spans/:spanId", async (c) => {
    const span = await repo.getBySpanId(c.req.param("spanId"));
    return span ? c.json(span, 200) : c.json({ error: "not found" }, 404);
  });

  return app;
}
