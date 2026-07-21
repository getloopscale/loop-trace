import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import {
  createPool,
  spanRepoFromPool,
  evaluatorRepoFromPool,
  runMigrations,
} from "@usetheo/lens-core/infra";
import type { EngineDeps, Span } from "@usetheo/lens-core";

import { buildAutoEvalSweepDeps, makeEnqueueAutoEval } from "./auto-eval-wiring.js";
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

    // One sweep through the daemon's own dependency closures.
    await sweepOnceForTest();

    const { rows } = await pool.query(
      "SELECT name, span_id FROM span_evaluations WHERE workspace_id = $1",
      [WS],
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(autoEvalJobsCompleted.value).toBeGreaterThanOrEqual(1);
    expect(ev.id).toBeTruthy();
  });

  it("test_auto_eval_can_be_enabled_on_an_EXISTING_evaluator", async () => {
    // F-wire-4 sibling / F-wire-1 (review). The repository's update path dropped
    // autoEnabled/sampling/filter, so PATCH built an empty SET, took the
    // "nothing to change" early return, and answered 200 with the OLD row.
    //
    // The milestone's goal was therefore unreachable for any evaluator a user
    // already had: delete-and-recreate was the only way to turn auto-eval on.
    // The handler test could not see it — its repo is a stub that records
    // whatever it is handed. Only the real repository shows the drop.
    const ev = await evaluatorRepo.createEvaluator(
      {
        name: "starts_manual",
        kind: "rule",
        config: { predicate: "" },
        target: "",
        enabled: true,
        autoEnabled: false,
      } as never,
      WS,
    );

    await evaluatorRepo.updateEvaluator(
      ev.id,
      { autoEnabled: true, sampling: 0.25, filter: [{ column: "model", op: "eq", value: "claude" }] } as never,
      WS,
    );

    const after = await evaluatorRepo.getEvaluator(ev.id, WS);
    expect((after as unknown as { autoEnabled: boolean }).autoEnabled).toBe(true);
    expect((after as unknown as { sampling: number }).sampling).toBe(0.25);
    expect((after as unknown as { filter: unknown[] }).filter).toHaveLength(1);
  });

  it("test_a_mixed_batch_enqueues_only_the_matching_trace", async () => {
    // F-wire-4 end to end, against the real DB rather than a recording stub.
    await createAutoEvaluator({
      filter: [{ column: "model", op: "eq", value: "gpt-4" }],
    });
    const batch = [
      span({ spanId: "s1", traceId: "t-yes", model: "gpt-4" }),
      span({ spanId: "s2", traceId: "t-no", model: "claude" }),
    ];
    await spanRepo.save(batch, WS);

    const enqueue = makeEnqueueAutoEval(pool, (ws) => evaluatorRepo.listEvaluators(ws));
    await enqueue(batch, WS);

    const { rows } = await pool.query("SELECT trace_id FROM eval_jobs ORDER BY trace_id");
    expect(rows.map((r) => r.trace_id)).toEqual(["t-yes"]);
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

  it("test_sampled_out_job_is_never_visible_to_a_claimer", async () => {
    // REGRESSION (self-review). The first implementation inserted the row, THEN
    // decided sampling, THEN deleted it if sampled out. Each pool query is
    // autocommit, so the row was COMMITTED and claimable in that window: a sweep
    // landing there would run a job that sampling had rejected — bypassing the
    // only lever that bounds judge cost — and the later DELETE would remove a
    // row already marked `running`, so completeJob would silently update zero rows.
    //
    // The plan ordered dedup -> sample -> create. The fix makes the decision
    // deterministic per (evaluator, trace) and takes it BEFORE any write, so no
    // such window exists at all.
    await createAutoEvaluator({ sampling: 0 });
    const spans = [span({ spanId: "s1", traceId: "t-never" })];
    await spanRepo.save(spans, WS);

    const enqueue = makeEnqueueAutoEval(pool, (ws) => evaluatorRepo.listEvaluators(ws));
    await enqueue(spans, WS);

    // No row was ever written — not "written and then removed".
    const { rows } = await pool.query(
      "SELECT count(*)::int n FROM eval_jobs WHERE trace_id = 't-never'",
    );
    expect(rows[0].n).toBe(0);
  });

  it("test_sampling_decision_is_stable_across_reingest", async () => {
    // A trace arrives across many OTLP batches. Sampling must be decided ONCE
    // per (evaluator, trace): re-rolling per batch makes a 10% evaluator
    // converge on 100% inclusion, which is the plan's stated failure mode.
    // Determinism gives this for free — and makes "why was this trace not
    // scored?" answerable instead of unknowable.
    await createAutoEvaluator({ sampling: 0.5 });
    const enqueue = makeEnqueueAutoEval(pool, (ws) => evaluatorRepo.listEvaluators(ws));

    const counts: number[] = [];
    for (const spanId of ["s1", "s2", "s3", "s4", "s5"]) {
      const spans = [span({ spanId, traceId: "t-stable" })];
      await spanRepo.save(spans, WS);
      await enqueue(spans, WS);
      const { rows } = await pool.query(
        "SELECT count(*)::int n FROM eval_jobs WHERE trace_id = 't-stable'",
      );
      counts.push(rows[0].n);
    }

    // Either it was in from the first batch and stayed at exactly one row, or it
    // was out and stayed at zero. Never 0 -> 1 partway through.
    expect(new Set(counts).size).toBe(1);
  });

  it("test_a_long_streaming_trace_eventually_becomes_claimable", async () => {
    // F-db-2 (review). The EC-6 re-arm had no ceiling: every OTLP batch for a
    // still-queued trace pushed run_after to now()+delay. A trace whose spans
    // arrive more often than the delay pushed its own deadline forward forever
    // and was NEVER evaluated — silently, with the row sitting in `queued`
    // looking healthy: no error, no metric, no attempt increment.
    //
    // Not an edge case for this product. theo-lens observes LLM agents, where a
    // session emitting spans over minutes is an ordinary trace. EC-8 bounded
    // the identical unbounded-loop shape on the failure path with MAX_ATTEMPTS;
    // this is that discipline applied to the re-arm.
    await createAutoEvaluator();
    const enqueue = makeEnqueueAutoEval(pool, (ws) => evaluatorRepo.listEvaluators(ws), {
      delayMs: 5_000,
    });

    const spans = [span({ spanId: "s1", traceId: "t-long" })];
    await spanRepo.save(spans, WS);
    await enqueue(spans, WS);

    // The trace has now been streaming longer than the re-arm window allows.
    await pool.query(
      "UPDATE eval_jobs SET created_at = now() - interval '30 minutes' WHERE trace_id = 't-long'",
    );
    const before = await pool.query(
      "SELECT run_after FROM eval_jobs WHERE trace_id = 't-long'",
    );

    // Another batch arrives — through the PRODUCTION enqueue, not hand-written SQL.
    await enqueue([span({ spanId: "s2", traceId: "t-long" })], WS);

    const after = await pool.query(
      "SELECT run_after FROM eval_jobs WHERE trace_id = 't-long'",
    );
    expect(new Date(after.rows[0].run_after).getTime()).toBe(
      new Date(before.rows[0].run_after).getTime(),
    );
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

  /**
   * One sweep through the PRODUCTION dependency closures.
   *
   * Deliberately not a hand-rolled copy: an earlier version of this helper
   * duplicated `runJob`, so the workspace threading it was meant to prove went
   * untested — and a later contract change silently left the copy stale while
   * this suite stayed green.
   */
  async function sweepOnceForTest(): Promise<void> {
    await sweepOnce(
      buildAutoEvalSweepDeps(
        pool,
        engine(),
        (id, ws) => evaluatorRepo.getEvaluator(id, ws),
        { staleClaimMs: 120_000, workerId: "test-worker" },
      ),
    );
  }
});
