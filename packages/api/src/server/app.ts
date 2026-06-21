import { Hono } from "hono";
import {
  type SpanRepository,
  traceListResponseSchema,
  traceCostSchema,
  costByPeriodResponseSchema,
  toolStatsResponseSchema,
} from "@usetheo/lens-core";

import { parseResourceSpans } from "../otlp/parse-resource-spans.js";
import { OtlpParseError } from "../otlp/otlp-error.js";
import { decodeOtlpBody } from "../otlp/decode-protobuf.js";
import { spansIngested, tracesIngested, logIngest } from "./metrics.js";

/**
 * Build the Hono app. Depends only on the {@link SpanRepository} port (DIP) — the
 * concrete Drizzle adapter is injected by the composition root.
 *
 *  - POST /v1/traces        : OTLP ingest, JSON + protobuf (+ gzip); 415 on other
 *  - GET  /v1/traces         : list executions newest-first (stable list DTO, M3)
 *  - GET  /v1/spans/:id      : read one span back (404 when absent)
 *  - GET  /v1/traces/:id     : reconstructed trace tree (404 when absent)
 *  - GET  /v1/traces/:id/cost: per-trace cost summary (404 when absent, M5)
 *  - GET  /v1/analytics/cost : day/week cost aggregation (?period=day|week, M5)
 *  - GET  /v1/analytics/tools: per-tool stats ranking (M6)
 *  - GET  /v1/analytics/tools/:name/traces : executions that called a tool (M6 drill-down)
 */
export function createApp(repo: SpanRepository): Hono {
  const app = new Hono();

  // Fail-loud, fail-clear (Rule 8): any unhandled error (e.g. Postgres
  // unavailable during repo.save) is logged with context and surfaced as 500.
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
    if (
      !contentType.includes("application/json") &&
      !contentType.includes("application/x-protobuf")
    ) {
      return c.json(
        { error: "unsupported content-type (use application/json or application/x-protobuf)" },
        415,
      );
    }

    const raw = Buffer.from(await c.req.arrayBuffer());

    let envelope: unknown;
    try {
      envelope = decodeOtlpBody(raw, contentType, c.req.header("content-encoding"));
    } catch (err) {
      if (err instanceof OtlpParseError) return c.json({ error: err.message }, 400);
      throw err;
    }

    let toSave;
    try {
      toSave = parseResourceSpans(envelope);
    } catch (err) {
      if (err instanceof OtlpParseError) return c.json({ error: err.message }, 400);
      throw err;
    }

    if (toSave.length === 0) {
      return c.json({}, 200);
    }

    await repo.save(toSave);
    spansIngested.add(toSave.length);
    tracesIngested.add(new Set(toSave.map((s) => s.traceId)).size);
    logIngest(toSave.length);
    return c.json({ partialSuccess: {} }, 200);
  });

  app.get("/v1/traces", async (c) => {
    // Parse through the strict DTO at the boundary so the no-column-leak invariant
    // (risk #2) is enforced at runtime, not just by adapter discipline (review F-arch-1).
    const list = traceListResponseSchema.parse(await repo.listTraces());
    return c.json(list, 200);
  });

  app.get("/v1/spans/:spanId", async (c) => {
    const span = await repo.getBySpanId(c.req.param("spanId"));
    return span ? c.json(span, 200) : c.json({ error: "not found" }, 404);
  });

  app.get("/v1/traces/:traceId/cost", async (c) => {
    const cost = await repo.getTraceCost(c.req.param("traceId"));
    return cost
      ? c.json(traceCostSchema.parse(cost), 200)
      : c.json({ error: "not found" }, 404);
  });

  app.get("/v1/traces/:traceId", async (c) => {
    const tree = await repo.getTraceTree(c.req.param("traceId"));
    return tree ? c.json(tree, 200) : c.json({ error: "not found" }, 404);
  });

  app.get("/v1/analytics/tools", async (c) => {
    const stats = await repo.aggregateToolStats();
    return c.json(toolStatsResponseSchema.parse(stats), 200);
  });

  app.get("/v1/analytics/tools/:toolName/traces", async (c) => {
    const list = await repo.listTracesForTool(c.req.param("toolName"));
    return c.json(traceListResponseSchema.parse(list), 200);
  });

  app.get("/v1/analytics/cost", async (c) => {
    // Whitelist the period (fail-fast on anything but day/week, Rule 8); default day.
    const raw = c.req.query("period");
    if (raw !== undefined && raw !== "day" && raw !== "week") {
      return c.json({ error: "invalid period (use day or week)" }, 400);
    }
    const result = await repo.aggregateCostByPeriod(raw === "week" ? "week" : "day");
    return c.json(costByPeriodResponseSchema.parse(result), 200);
  });

  return app;
}
