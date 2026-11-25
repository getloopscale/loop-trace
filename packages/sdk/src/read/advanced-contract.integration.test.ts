import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  RateLimiter,
  type EngineDeps,
  type SpanRepository, EvaluatorRunJobRegistry } from "@looptrace/core";
import {
  createSpanRepository,
  evaluatorRepoFromPool,
  migrateLatest,
} from "@looptrace/core/infra";
import { createApp } from "@looptrace/api";
import type pg from "pg";

import { LensReadClient } from "./client.js";

/**
 * M114 — the advanced-write contract proof. Drives the M111/M112 methods against the REAL engine
 * (`createApp` with a real evaluator repo + a real Postgres from Testcontainers, `app.fetch` injected)
 * and asserts the mutation is observable. A `rule` evaluator's `runEvaluator` needs no LLM provider, so
 * it runs hermetically; the `llm_judge` / replay / experiment paths (provider-gated) are proven at the
 * unit layer (M111/M113) + would 503 fail-closed here without a provider, so they are not driven live.
 * Gated on LOOPTRACE_PG_URI.
 */
const PG_URI = process.env["LOOPTRACE_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

suite("LensReadClient advanced-write contract (M114)", () => {
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
      { repo: evaluatorRepo, engine, runJobs: new EvaluatorRunJobRegistry() },
      { spanRepo: repo, chat: null, limiter: new RateLimiter(60) },
    );
    const engineFetch: typeof fetch = (input, init) =>
      app.fetch(new Request(typeof input === "string" ? input : input.toString(), init));
    client = new LensReadClient({
      baseUrl: "http://engine.local",
      apiKey: "looptrace_live_contract_test",
      fetch: engineFetch,
    });
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE spans, traces, sessions, evaluators, monitors, labeling_queue_items, copilot_feedback",
    );
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
  });

  afterAll(async () => {
    await pool.end();
  });

  it("evaluator CRUD round-trips against the real engine", async () => {
    const ev = await client.createEvaluator({
      name: "quality",
      kind: "rule",
      config: { predicate: "status:error" },
    });
    expect(ev.id).toBeTruthy();
    expect(ev.enabled).toBe(true);

    const updated = await client.updateEvaluator(ev.id, { enabled: false });
    expect(updated.enabled).toBe(false);

    await client.deleteEvaluator(ev.id);
  });

  it("guard create + delete round-trips", async () => {
    const ev = await client.createEvaluator({ name: "q", kind: "rule", config: { predicate: "status:ok" } });
    const guard = await client.createMonitor({ evaluatorId: ev.id, operator: "gte", threshold: 0.8 });
    expect(guard.id).toBeTruthy();
    await client.deleteMonitor(guard.id);
  });

  it("runEvaluator (rule — no provider needed) returns a typed RunResult", async () => {
    const ev = await client.createEvaluator({ name: "r", kind: "rule", config: { predicate: "status:ok" } });
    const result = await client.runEvaluator(ev.id, { limit: 10 });
    expect(typeof result.written).toBe("number");
    expect(typeof result.skipped).toBe("number");
    expect(result.evaluator).toBeDefined();
  });

  it("labeling enqueue → resolve round-trips", async () => {
    const item = await client.enqueueForLabeling("sdk-t1", { spanId: "sdk-a1" });
    expect(item.status).toBe("pending");
    const resolved = await client.resolveLabelingItem(item.id, { label: "good" });
    expect(resolved.status).toBe("resolved");
    expect(resolved.label).toBe("good");
  });

  it("copilot ask-feedback submit → delete round-trips", async () => {
    const rec = await client.submitAskFeedback("sdk-t1", { turnId: "turn-1", label: "up" });
    expect(rec.label).toBe("up");
    expect(rec.id).toBeTruthy();
    await client.deleteAskFeedback("sdk-t1", "turn-1");
  });
});
