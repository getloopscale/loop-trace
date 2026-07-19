import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  RateLimiter,
  type ChatClient,
  type EngineDeps,
  type ExperimentRunItem,
  type SpanRepository,
} from "@usetheo/lens-core";
import {
  createSpanRepository,
  evaluatorRepoFromPool,
  migrateLatest,
} from "@usetheo/lens-core/infra";
import { createApp } from "@usetheo/lens-api";
import type pg from "pg";

import { LensReadClient } from "./client.js";

/**
 * M117 (T2.3) — the drift guard for the 9 HAND (bare-`c.json`) read methods. No generated schema pins
 * these types, so THIS hermetic contract test IS the guard (ADR D1): it drives each SDK method against
 * the REAL engine (`createApp` + a real evaluator repo + a real Postgres from Testcontainers,
 * `app.fetch` injected) and asserts every declared field is present with the right primitive kind.
 *
 * For the asymmetric pairs it feeds the write's returned id into the read (Recommendation 4 —
 * write→read round-trip): createEvaluator→getEvaluator/listEvaluators, createGuard→listGuards,
 * a guard→getGuardBreaches, and experiment runs seeded via the repo → getExperimentRun/
 * listExperimentRuns/compareExperimentRuns. `askCopilot` is driven against a STUB chat provider
 * (the copilot fails closed 503 with no provider) to prove the `{ answer }` shape without a real LLM.
 * Gated on THEOLENS_PG_URI.
 */
const PG_URI = process.env["THEOLENS_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

/** A deterministic stub ChatClient so `askCopilot` returns a real answer without a live provider. */
const stubChat: ChatClient = {
  ask: (): Promise<string> => Promise.resolve("The step failed because the tool returned a non-zero exit."),
};

function experimentItem(over: Partial<ExperimentRunItem>): ExperimentRunItem {
  return {
    datasetItemTraceId: "t1",
    output: "out",
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    costUsd: 0.001,
    latencyMs: 100,
    model: "m",
    scores: [{ name: "acc", score: 1, label: "pass" }],
    ...over,
  };
}

function runInput(over: Record<string, unknown> = {}) {
  return {
    datasetId: "11111111-1111-1111-1111-111111111111",
    name: "run-1",
    variant: { model: "gpt-x" },
    status: "completed" as const,
    truncated: false,
    createdBy: "reviewer-a",
    items: [experimentItem({ datasetItemTraceId: "t1" }), experimentItem({ datasetItemTraceId: "t2", scores: [{ name: "acc", score: 0, label: "fail" }] })],
    ...over,
  };
}

suite("LensReadClient ↔ engine — M117 HAND read parity (T2.3, drift guard)", () => {
  let app: ReturnType<typeof createApp>;
  let repo: SpanRepository;
  let pool: pg.Pool;
  let client: LensReadClient;

  beforeAll(async () => {
    const made = createSpanRepository(PG_URI as string);
    repo = made.repo;
    pool = made.pool;
    await migrateLatest(pool);
    const evaluatorRepo = evaluatorRepoFromPool(pool);
    const engine: EngineDeps = { evaluatorRepo, spanRepo: repo, judge: null, backfillMax: 100 };
    app = createApp(
      repo,
      undefined,
      {},
      { repo: evaluatorRepo, engine },
      { spanRepo: repo, chat: stubChat, limiter: new RateLimiter(60) },
      undefined,
      // Experiment routes (list/get/compare are `observability:read` — no provider needed to READ;
      // the runs themselves are seeded via the repo below, so `chat: null` is fine here).
      { spanRepo: repo, evaluatorRepo, chat: null, limiter: new RateLimiter(60) },
    );
    const engineFetch: typeof fetch = (input, init) =>
      app.fetch(new Request(typeof input === "string" ? input : input.toString(), init));
    client = new LensReadClient({
      baseUrl: "http://engine.local",
      apiKey: "theo_live_contract_test",
      fetch: engineFetch,
    });
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE spans, traces, sessions, replay_sessions, evaluators, guards, labeling_queue_items, copilot_feedback, experiment_runs, experiment_run_items",
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Ingest a single-span trace so getTrace / askCopilot have a real trace to read. */
  async function seedTrace(): Promise<void> {
    const span = {
      spanId: "sdk-a1",
      traceId: "sdk-t1",
      name: "chat",
      startTimeUnixNano: "1700000000000000000",
      endTimeUnixNano: "1700000000500000000",
      attributes: { "gen_ai.request.model": "gpt-4" },
    };
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] }),
    });
    expect(res.status).toBe(200);
  }

  it("getTrace returns the trace tree (root span + children array)", async () => {
    await seedTrace();
    const tree = await client.getTrace("sdk-t1");
    expect(tree.traceId).toBe("sdk-t1");
    expect(tree.spanId).toBeTruthy();
    expect(Array.isArray(tree.children)).toBe(true);
  });

  it("test_createEvaluator_then_getEvaluator_returns_same_id (write→read round-trip)", async () => {
    const created = await client.createEvaluator({ name: "quality", kind: "rule", config: { predicate: "status:error" } });
    const read = await client.getEvaluator(created.id);
    expect(read.id).toBe(created.id);
    expect(read.name).toBe("quality");
    expect(read.kind).toBe("rule");
    expect(typeof read.createdAt).toBe("string");
    expect(typeof read.target).toBe("string");
    expect(typeof read.enabled).toBe("boolean");
  });

  it("createEvaluator → listEvaluators contains the created evaluator", async () => {
    const created = await client.createEvaluator({ name: "listed", kind: "rule", config: { predicate: "status:ok" } });
    const res = await client.listEvaluators();
    expect(Array.isArray(res.evaluators)).toBe(true);
    expect(res.evaluators.some((e) => e.id === created.id)).toBe(true);
  });

  it("createGuard → listGuards contains the created guard", async () => {
    const ev = await client.createEvaluator({ name: "g-ev", kind: "rule", config: { predicate: "status:ok" } });
    const guard = await client.createGuard({ evaluatorId: ev.id, operator: "gte", threshold: 0.8 });
    const res = await client.listGuards();
    expect(Array.isArray(res.guards)).toBe(true);
    expect(res.guards.some((g) => g.id === guard.id)).toBe(true);
  });

  it("createGuard → getGuardBreaches returns the { traceIds } wrapper", async () => {
    const ev = await client.createEvaluator({ name: "breach-ev", kind: "rule", config: { predicate: "status:error" } });
    const guard = await client.createGuard({ evaluatorId: ev.id, operator: "lt", threshold: 0.5 });
    const res = await client.getGuardBreaches(guard.id);
    expect(Array.isArray(res.traceIds)).toBe(true);
    for (const id of res.traceIds) expect(typeof id).toBe("string");
  });

  it("seeded run → getExperimentRun returns the same id with its items (write→read round-trip)", async () => {
    const seeded = await repo.createExperimentRun(runInput());
    const read = await client.getExperimentRun(seeded.id);
    expect(read.id).toBe(seeded.id);
    expect(read.datasetId).toBe(seeded.datasetId);
    expect(read.status).toBe("completed");
    expect(typeof read.itemCount).toBe("number");
    expect(typeof read.passCount).toBe("number");
    expect(typeof read.totalCostUsd).toBe("number");
    expect(Array.isArray(read.items)).toBe(true);
    expect(read.items?.length).toBe(2);
    // Drift guard extends to the nested ExperimentRunItem fields — a shape change on any of these would
    // otherwise slip past a length-only assertion (review INFO).
    const item = read.items![0];
    expect(typeof item.datasetItemTraceId).toBe("string");
    expect(typeof item.promptTokens).toBe("number");
    expect(typeof item.completionTokens).toBe("number");
    expect(typeof item.totalTokens).toBe("number");
    expect(typeof item.latencyMs).toBe("number");
    expect(typeof item.model).toBe("string");
    expect(Array.isArray(item.scores)).toBe(true);
  });

  it("seeded runs → listExperimentRuns returns the { runs } wrapper (with datasetId filter)", async () => {
    const dsId = "22222222-2222-2222-2222-222222222222";
    const seeded = await repo.createExperimentRun(runInput({ datasetId: dsId }));
    const res = await client.listExperimentRuns({ datasetId: dsId });
    expect(Array.isArray(res.runs)).toBe(true);
    expect(res.runs.some((r) => r.id === seeded.id)).toBe(true);
    // An unrelated dataset id returns none — the filter is honored server-side.
    const none = await client.listExperimentRuns({ datasetId: "33333333-3333-3333-3333-333333333333" });
    expect(none.runs.some((r) => r.id === seeded.id)).toBe(false);
  });

  it("seeded runs → compareExperimentRuns returns { runs, deltas } and pins the query contract", async () => {
    const a = await repo.createExperimentRun(runInput({ name: "A" }));
    const b = await repo.createExperimentRun(runInput({ name: "B" }));
    const res = await client.compareExperimentRuns([a.id, b.id]);
    expect(Array.isArray(res.runs)).toBe(true);
    expect(res.runs.length).toBe(2);
    expect(res.deltas).not.toBeNull();
    expect(typeof res.deltas?.passCountDelta).toBe("number");
    expect(typeof res.deltas?.passRateDelta).toBe("number");
    expect(typeof res.deltas?.totalCostDelta).toBe("number");
    // avgScoreDelta / avgLatencyDelta may be null when a metric is absent on either side.
  });

  it("compareExperimentRuns with a single id is rejected 400 INVALID_BODY (needs ≥2)", async () => {
    const a = await repo.createExperimentRun(runInput());
    const err = await client.compareExperimentRuns([a.id]).then(
      () => null,
      (e: unknown) => e as { status?: number; code?: string },
    );
    expect(err?.status).toBe(400);
    expect(err?.code).toBe("INVALID_BODY");
  });

  it("test_askCopilot_returns_answer_for_seeded_trace (stubbed provider)", async () => {
    await seedTrace();
    const res = await client.askCopilot("sdk-t1", { question: "why did this step fail?" });
    expect(typeof res.answer).toBe("string");
    expect(res.answer.length).toBeGreaterThan(0);
  });
});
