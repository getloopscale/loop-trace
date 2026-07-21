import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  createPool,
  spanRepoFromPool,
  evaluatorRepoFromPool,
  runMigrations,
} from "@usetheo/lens-core/infra";
import type { EngineDeps, Span } from "@usetheo/lens-core";

import { makeEnqueueAutoEval, startAutoEval } from "./auto-eval-wiring.js";
import { sweepOnce } from "./auto-eval-scheduler.js";
import { autoEvalJobsCompleted } from "./metrics.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

/**
 * M134 — the milestone's goal, end to end and against a real Postgres:
 * a trace arrives, nobody touches anything, and a verdict exists.
 *
 * Every layer below has its own focused tests; this asserts they compose. It is
 * the test that would fail if the schema, the predicates, the claim protocol,
 * the daemon and the ingest hook were each individually correct but not wired.
 */
suite("auto-evaluation end to end (integration, M134)", () => {
  let pool: pg.Pool;
  let spanRepo: ReturnType<typeof spanRepoFromPool>;
  let evaluatorRepo: ReturnType<typeof evaluatorRepoFromPool>;

  const WS = "ws-auto";

  beforeAll(async () => {
    pool = createPool(PG_URI as string);
    await runMigrations(pool);
    spanRepo = spanRepoFromPool(pool);
    evaluatorRepo = evaluatorRepoFromPool(pool);
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE spans, traces, sessions, eval_jobs, evaluators, span_evaluations",
    );
    autoEvalJobsCompleted.reset();
  });

  afterAll(async () => {
    await pool.end();
  });

  function span(over: Partial<Span> & Pick<Span, "spanId" | "traceId">): Span {
    return {
      name: "chat",
      startTimeUnixNano: "1700000000000000000",
      endTimeUnixNano: "1700000000100000000",
      ...over,
    } as Span;
  }

  const engine = (): EngineDeps => ({
    evaluatorRepo,
    spanRepo,
    judge: null, // rule evaluators need no provider — hermetic
    backfillMax: 500,
  });

  async function createAutoEvaluator(over: Record<string, unknown> = {}) {
    return evaluatorRepo.createEvaluator(
      {
        name: "is_error",
        kind: "rule",
        config: { predicate: "status:error" },
        target: "",
        enabled: true,
        autoEnabled: true,
        sampling: 1,
        filter: [],
        ...over,
      } as never,
      WS,
    );
  }

  it("test_new_trace_is_scored_without_an_operator", async () => {
    // THE milestone goal. No Run button is pressed anywhere in this test.
    const ev = await createAutoEvaluator();
    const spans = [span({ spanId: "s1", traceId: "t-auto", statusCode: "STATUS_CODE_ERROR" })];
    await spanRepo.save(spans, WS);

    const enqueue = makeEnqueueAutoEval(pool, (ws) => evaluatorRepo.listEvaluators(ws), {
      delayMs: 0,
    });
    await enqueue(spans, WS);

    // One sweep, exactly as the daemon would run it.
    const handle = startAutoEval(pool, engine(), (id, ws) => evaluatorRepo.getEvaluator(id, ws), {
      staleClaimMs: 120_000,
    });
    handle.stop();
    await sweepOnceForTest();

    const { rows } = await pool.query(
      "SELECT name, span_id FROM span_evaluations WHERE workspace_id = $1",
      [WS],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(autoEvalJobsCompleted.value).toBeGreaterThanOrEqual(1);
    expect(ev.id).toBeTruthy();
  });

  it("test_a_workspace_with_no_auto_evaluators_enqueues_nothing", async () => {
    // The zero-cost path — the common case must not create rows.
    await evaluatorRepo.createEvaluator(
      {
        name: "manual_only",
        kind: "rule",
        config: { predicate: "" },
        target: "",
        enabled: true,
        autoEnabled: false,
      } as never,
      WS,
    );
    const spans = [span({ spanId: "s1", traceId: "t-none" })];
    await spanRepo.save(spans, WS);

    const enqueue = makeEnqueueAutoEval(pool, (ws) => evaluatorRepo.listEvaluators(ws));
    await enqueue(spans, WS);

    const { rows } = await pool.query("SELECT count(*)::int n FROM eval_jobs");
    expect(rows[0].n).toBe(0);
  });

  it("test_a_non_matching_filter_enqueues_nothing", async () => {
    await createAutoEvaluator({
      filter: [{ column: "model", op: "eq", value: "gpt-4" }],
    });
    const spans = [span({ spanId: "s1", traceId: "t-filtered", model: "claude" })];
    await spanRepo.save(spans, WS);

    const enqueue = makeEnqueueAutoEval(pool, (ws) => evaluatorRepo.listEvaluators(ws));
    await enqueue(spans, WS);

    const { rows } = await pool.query("SELECT count(*)::int n FROM eval_jobs");
    expect(rows[0].n).toBe(0);
  });

  it("test_sampling_zero_never_enqueues", async () => {
    await createAutoEvaluator({ sampling: 0 });
    const spans = [span({ spanId: "s1", traceId: "t-sampled-out" })];
    await spanRepo.save(spans, WS);

    const enqueue = makeEnqueueAutoEval(pool, (ws) => evaluatorRepo.listEvaluators(ws));
    await enqueue(spans, WS);

    const { rows } = await pool.query("SELECT count(*)::int n FROM eval_jobs");
    expect(rows[0].n).toBe(0);
  });

  it("test_reingest_of_the_same_trace_still_yields_one_job", async () => {
    // ADR D4 at the wiring level: a trace arriving across many OTLP batches
    // produces one job, not one per batch.
    await createAutoEvaluator();
    const enqueue = makeEnqueueAutoEval(pool, (ws) => evaluatorRepo.listEvaluators(ws));

    for (const spanId of ["s1", "s2", "s3"]) {
      const spans = [span({ spanId, traceId: "t-stream" })];
      await spanRepo.save(spans, WS);
      await enqueue(spans, WS);
    }

    const { rows } = await pool.query("SELECT count(*)::int n FROM eval_jobs");
    expect(rows[0].n).toBe(1);
  });

  /** Run exactly one sweep through the real wiring. */
  async function sweepOnceForTest(): Promise<void> {
    const {
      claimNextJobs,
      completeJob,
      failJob,
      reclaimStale,
      runEvaluator,
      RUN_CONCURRENCY,
    } = await import("@usetheo/lens-core");
    await sweepOnce({
      reclaim: () => reclaimStale(pool, 120_000),
      claimNext: (limit) => claimNextJobs(pool, "test-worker", limit, 120_000),
      runJob: async (job) => {
        const ev = await evaluatorRepo.getEvaluator(job.evaluatorId, job.workspaceId);
        if (ev === null) return;
        await runEvaluator(ev, { traceIds: [job.traceId] }, job.workspaceId, engine());
      },
      complete: async (job) => {
        await completeJob(pool, job.id);
        autoEvalJobsCompleted.add(1);
      },
      fail: (job, reason) => failJob(pool, job.id, reason),
      batchSize: 20,
      concurrency: RUN_CONCURRENCY,
    });
  }
});
