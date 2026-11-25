import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type SpanRepository } from "@looptrace/core";
import { createSpanRepository, migrateLatest } from "@looptrace/core/infra";
import { createApp } from "@looptrace/api";
import type pg from "pg";

import { LensReadClient } from "./client.js";
import { LensApiError } from "./errors.js";

/**
 * M105 — the SDK ↔ engine contract proof. Drives every `LensReadClient` method against the REAL
 * engine app (`createApp(repo)` + a real repo + a real Postgres, from the Testcontainers globalSetup),
 * with `app.fetch` injected as the client transport. In-process is MORE hermetic + deterministic than
 * a socket while exercising the exact handler → repo → DB → envelope path a customer hits. Gated on
 * LOOPTRACE_PG_URI like the rest of the integration suite.
 *
 * The `looptrace_live_*` per-tenant auth + scope enforcement is proven end-to-end at the edge (M40
 * ForwardAuth e2e); here the engine runs single-tenant (default workspace) so the focus is the
 * request/response shape round-trip + the real `{code,message}` error envelope.
 */
const PG_URI = process.env["LOOPTRACE_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

suite("LensReadClient ↔ engine contract (M105)", () => {
  let app: ReturnType<typeof createApp>;
  let repo: SpanRepository;
  let pool: pg.Pool;
  let client: LensReadClient;

  beforeAll(async () => {
    const created = createSpanRepository(PG_URI as string);
    repo = created.repo;
    pool = created.pool;
    await migrateLatest(pool);
    app = createApp(repo);
    // Adapt the SDK's fetch(url, init) → the engine's app.fetch(Request). Real handlers, no socket.
    const engineFetch: typeof fetch = (input, init) =>
      app.fetch(new Request(typeof input === "string" ? input : input.toString(), init));
    client = new LensReadClient({
      baseUrl: "http://engine.local",
      apiKey: "looptrace_live_contract_test",
      fetch: engineFetch,
    });
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE spans, traces, sessions");
  });

  afterAll(async () => {
    await pool.end();
  });

  async function seedTrace(): Promise<void> {
    const span = {
      spanId: "sdk-a1",
      traceId: "sdk-t1",
      name: "chat",
      startTimeUnixNano: "1700000000000000000",
      endTimeUnixNano: "1700000000500000000",
      attributes: {
        "gen_ai.request.model": "gpt-4",
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 5,
      },
    };
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] }),
    });
    expect(res.status).toBe(200);
  }

  it("round-trips an ingested trace through every read method (typed, real engine)", async () => {
    await seedTrace();

    const traces = await client.listTraces();
    expect(traces.traces.some((t) => t.traceId === "sdk-t1")).toBe(true);

    const span = await client.getSpan("sdk-a1");
    expect(span.spanId).toBe("sdk-a1");
    expect(span.traceId).toBe("sdk-t1");

    // The aggregate endpoints must round-trip to their typed shape (status 200 + parseable body).
    expect((await client.observability()).range).toBeDefined();
    expect(Array.isArray((await client.listSessions()).sessions)).toBe(true);
    expect(Array.isArray((await client.costByPeriod()).buckets)).toBe(true);
    expect(Array.isArray((await client.toolStats()).tools)).toBe(true);
    expect(Array.isArray((await client.listDatasets()).datasets)).toBe(true);
  });

  it("maps a real 404 envelope to LensApiError{status:404,code:NOT_FOUND}", async () => {
    const err = await client.getSpan("does-not-exist").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LensApiError);
    expect((err as LensApiError).status).toBe(404);
    expect((err as LensApiError).code).toBe("NOT_FOUND");
  });
});
