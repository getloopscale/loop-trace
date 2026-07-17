import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSpanRepository, migrateLatest, type SpanRepository, type SDKMessage } from "@usetheo/lens-core";
import { createApp } from "@usetheo/lens-api";
import type pg from "pg";

import { recordRun } from "../ingest/theokit.js";
import { LensReadClient } from "./client.js";
import type { TraceTree } from "./types.js";

/**
 * M117 (T3.2) — the dual-path + byte-identical read-back contract for `recordRun`. Drives the ingest
 * against the REAL engine (`createApp(repo)` over Testcontainers Postgres, `app.fetch` injected):
 *   (a) the native `POST /v1/runs` happy path reads back via getTrace/listTraces;
 *   (b) a `fetch` seam that 404s `/v1/runs` proves the OTLP `/v1/traces` fallback still succeeds;
 *   (c) the read-back spans are BYTE-IDENTICAL across both paths (both go through the one
 *       SDKMessage→spans mapper, with the same injected `startTimeMs`) — the dual-path-divergence guard.
 * The engine's actual status for a truly-unmounted route is pinned (settles the 404-vs-405 question).
 * Deterministic via injected `startTimeMs` + injected `fetch`. Gated on THEOLENS_PG_URI.
 */
const PG_URI = process.env["THEOLENS_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

const RUN = "dual-path-run-1";
const messages: SDKMessage[] = [
  { type: "system", subtype: "init", agent_id: "agent-d", run_id: RUN, model: { id: "claude-opus-4-8" }, tools: ["Bash"] },
  { type: "user", agent_id: "agent-d", run_id: RUN, message: { role: "user", content: [{ type: "text", text: "List the files" }] } },
  { type: "tool_call", agent_id: "agent-d", run_id: RUN, call_id: "c1", name: "Bash", status: "completed", args: { command: "ls" }, result: "file.txt\n" },
  { type: "assistant", agent_id: "agent-d", run_id: RUN, message: { role: "assistant", content: [{ type: "text", text: "One file: file.txt" }] } },
  { type: "status", agent_id: "agent-d", run_id: RUN, status: "FINISHED" },
];
const START_MS = 1_700_000_000_000;

/** Serialize a trace tree to a stable, comparison-ready shape (drop volatile ingest metadata). */
function normalizeTree(tree: TraceTree): unknown {
  const strip = (n: TraceTree): unknown => {
    // Only compare the fields the mapper produces; sort children by spanId for order-independence.
    const { children, ...rest } = n as TraceTree & Record<string, unknown>;
    const kids = [...(children ?? [])].sort((a, b) => a.spanId.localeCompare(b.spanId)).map(strip);
    return { ...rest, children: kids };
  };
  return strip(tree);
}

suite("recordRun dual-path + byte-identical read-back (M117 T3.2)", () => {
  let app: ReturnType<typeof createApp>;
  let repo: SpanRepository;
  let pool: pg.Pool;
  let client: LensReadClient;
  /** The real in-process engine transport. */
  let engineFetch: typeof fetch;

  beforeAll(async () => {
    const created = createSpanRepository(PG_URI as string);
    repo = created.repo;
    pool = created.pool;
    await migrateLatest(pool);
    app = createApp(repo);
    engineFetch = (input, init) => app.fetch(new Request(typeof input === "string" ? input : input.toString(), init));
    client = new LensReadClient({ baseUrl: "http://engine.local", apiKey: "theo_live_contract", fetch: engineFetch });
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE spans, traces, sessions");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("pins the engine's status for a truly-unmounted route (404, the fallback trigger)", async () => {
    // recordRun falls back on 404 OR 405; here we settle the open question empirically — Hono answers a
    // never-registered route with 404 (Not Found), so an older engine without /v1/runs would 404.
    const res = await engineFetch("http://engine.local/v1/definitely-not-a-route", {
      method: "POST",
      headers: { authorization: "Bearer theo_live_contract", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });

  it("(a) native /v1/runs happy path — recordRun ingests and reads back", async () => {
    await recordRun(
      { messages },
      { baseUrl: "http://engine.local", apiKey: "theo_live_contract", fetch: engineFetch, startTimeMs: START_MS },
    );
    const { traces } = await client.listTraces({ limit: 50 });
    expect(traces.some((t) => t.traceId === RUN)).toBe(true);
    const tree = await client.getTrace(RUN);
    expect(tree.traceId).toBe(RUN);
    expect(JSON.stringify(tree)).toContain("Bash");
  });

  it("(b) 404 fallback — a /v1/runs 404 routes recordRun to /v1/traces and still succeeds", async () => {
    // The seam 404s /v1/runs but delegates every other path (including /v1/traces) to the real engine.
    const fallbackFetch: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/runs")) {
        return Promise.resolve(new Response(JSON.stringify({ code: "NOT_FOUND", message: "no route" }), { status: 404 }));
      }
      return engineFetch(input, init);
    };
    await recordRun(
      { messages },
      { baseUrl: "http://engine.local", apiKey: "theo_live_contract", fetch: fallbackFetch, startTimeMs: START_MS },
    );
    const tree = await client.getTrace(RUN);
    expect(tree.traceId).toBe(RUN);
    expect(JSON.stringify(tree)).toContain("Bash");
  });

  it("test_recordRun_readback_is_byte_identical_across_paths", async () => {
    // Ingest the same run via /v1/runs, capture the read-back tree, then truncate and re-ingest via the
    // 404→/v1/traces fallback. Both paths run the one mapper with the same startTimeMs → identical spans.
    await recordRun(
      { messages },
      { baseUrl: "http://engine.local", apiKey: "theo_live_contract", fetch: engineFetch, startTimeMs: START_MS },
    );
    const viaRuns = normalizeTree(await client.getTrace(RUN));

    await pool.query("TRUNCATE spans, traces, sessions");

    const fallbackFetch: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/runs")) {
        return Promise.resolve(new Response(JSON.stringify({ code: "NOT_FOUND", message: "no route" }), { status: 404 }));
      }
      return engineFetch(input, init);
    };
    await recordRun(
      { messages },
      { baseUrl: "http://engine.local", apiKey: "theo_live_contract", fetch: fallbackFetch, startTimeMs: START_MS },
    );
    const viaTraces = normalizeTree(await client.getTrace(RUN));

    // The serialized span sets are byte-identical regardless of ingest path (no dual-path divergence).
    expect(JSON.stringify(viaTraces)).toBe(JSON.stringify(viaRuns));
  });
});
