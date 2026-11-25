import { createHash } from "node:crypto";

import {
  claimNextJobs,
  completeJob,
  heartbeat,
  failJob,
  matchesFilter,
  reclaimStale,
  shouldSample,
  RUN_CONCURRENCY,
  runEvaluator,
  type ClaimedJob,
  type EngineDeps,
  type EvaluatorRecord,
  type FilterClause,
  type Queryable,
  type Span,
} from "@looptrace/core";

import {
  startAutoEvalScheduler,
  type AutoEvalSchedulerHandle,
  type AutoEvalSweepDeps,
} from "./auto-eval-scheduler.js";
import {
  autoEvalJobsCompleted,
  autoEvalJobsFailed,
  autoEvalJobsOrphaned,
  autoEvalHeartbeatFailures,
} from "./metrics.js";

/**
 * M134 — composition of the auto-evaluation loop.
 *
 * Two halves that never touch each other directly: the ingest side ENQUEUES,
 * the daemon side CLAIMS. They communicate only through `eval_jobs`, which is
 * the whole point of ADR D1 — the table is the queue, so a restart between the
 * two loses nothing.
 */

/** Default gap between sweeps. Trades detection latency against steady DB write load. */
export const DEFAULT_SWEEP_INTERVAL_MS = 15_000;
/**
 * How long a claim may go unrefreshed before another worker may take it.
 *
 * Deliberately longer than a judge call's p99 so a slow-but-alive worker is
 * never robbed mid-flight. The plan lists deriving this from measurement as an
 * open question; this default is the starting point, not a measured value.
 */
export const DEFAULT_STALE_CLAIM_MS = 120_000;
/** Jobs taken per sweep. Bounded so one sweep cannot monopolise the judge budget. */
export const DEFAULT_BATCH_SIZE = 20;
/**
 * Ceiling on how long a job may keep being re-armed by fresh batches.
 *
 * The EC-6 re-arm exists so a trace still arriving is scored on its full span
 * set rather than on whatever landed first. Without a ceiling it inverts into
 * starvation: a trace emitting spans more often than the delay pushes its own
 * `run_after` forward forever and is never evaluated — silently, with the row
 * sitting in `queued` looking healthy.
 *
 * That is the ordinary case for this product, not an edge case: looptrace
 * observes LLM agents, where a session emitting spans over minutes is a normal
 * trace. Past this window the job runs on whatever spans it has, which is a
 * strictly better outcome than never running.
 *
 * Same discipline as MAX_ATTEMPTS on the failure path (EC-8) — an unbounded
 * loop needs a bound, wherever it appears.
 */
export const DEFAULT_REARM_WINDOW_MS = 600_000;

/**
 * Map (evaluator, trace) to a stable value in [0,1) for the sampling draw.
 *
 * Deterministic rather than random, for three reasons that all fell out of
 * self-review:
 *
 *  1. **No write window.** The decision is taken BEFORE any statement, so a
 *     sampled-out job is never written. The first implementation inserted, then
 *     decided, then deleted — and because each pool query is autocommit, the row
 *     was committed and claimable in between. A sweep landing in that window ran
 *     a job sampling had rejected, defeating the only lever that bounds judge
 *     cost, and the delete then removed a row already marked `running`.
 *  2. **Stable across re-ingest.** A trace arriving in many OTLP batches gets
 *     the same answer every time, so a 10 % evaluator cannot converge on 100 %
 *     inclusion by being asked repeatedly (the plan's stated failure mode).
 *  3. **Answerable.** "Why was this trace not scored?" has an answer you can
 *     recompute, instead of "the dice said so".
 *
 * SHA-256 over the pair, first 6 bytes normalised — stdlib only (parsimony
 * rung 2), and well-distributed enough that the rate means what it says.
 *
 * `workspaceId` is deliberately NOT in the key, and that is safe only because
 * `evaluators.id` is a per-row uuid: the same evaluator NAME in two workspaces
 * is two different rows with two different ids (the unique constraint is on
 * `(workspace_id, name)`, not on `name`). So the draw is already tenant-distinct
 * transitively.
 *
 * That makes the id's shape load-bearing. Keying on evaluator NAME instead —
 * which IS shared across tenants — would correlate two workspaces' sampling
 * decisions for any trace id they happen to share. `test_draw_is_tenant_distinct`
 * pins this so the refactor that would break it fails loudly.
 */
function samplingDraw(evaluatorId: string, traceId: string): number {
  const digest = createHash("sha256")
    .update(`${evaluatorId}:${traceId}`)
    .digest();
  return digest.readUIntBE(0, 6) / 2 ** 48;
}

/**
 * Build the ingest-side hook: for every auto-enabled evaluator, and for every
 * TRACE in the batch whose spans match that evaluator's filter and which
 * survives sampling, insert one job row.
 *
 * Per-trace, not per-batch: the filter's contract is trace-level, so evaluating
 * it against the union of a batch's spans would let one matching trace drag
 * every other trace in the batch along.
 *
 * Ordering is load-bearing: **sample → insert**, never insert-then-reconsider.
 * Because the draw is deterministic per (evaluator, trace), deciding first
 * costs nothing and gives the stickiness the reference needed a dedup READ to
 * obtain — a 10 % evaluator cannot converge on 100 % inclusion by being asked
 * once per OTLP batch.
 *
 * A re-ingest of a trace whose job is still queued pushes `run_after` out
 * (EC-6), so a trace still streaming is scored once, on its full span set,
 * rather than once on whatever arrived first. Once claimed, the row is left
 * alone — otherwise a busy stream would starve its own evaluation.
 */
export function makeEnqueueAutoEval(
  q: Queryable,
  listEvaluators: (workspaceId: string) => Promise<EvaluatorRecord[]>,
  opts: {
    delayMs?: number;
    /** Ceiling on re-arming a still-queued job. See DEFAULT_REARM_WINDOW_MS. */
    rearmWindowMs?: number;
    /** Override the sampling draw. Tests only — production is deterministic. */
    draw?: (evaluatorId: string, traceId: string) => number;
  } = {},
): (spans: Span[], workspaceId: string) => Promise<void> {
  const delaySeconds = Math.max(0, Math.floor((opts.delayMs ?? 5_000) / 1000));
  const rearmSeconds = Math.max(
    0,
    Math.floor((opts.rearmWindowMs ?? DEFAULT_REARM_WINDOW_MS) / 1000),
  );

  return async (spans, workspaceId) => {
    if (spans.length === 0) return;

    const evaluators = await listEvaluators(workspaceId);
    const auto = evaluators.filter(
      (e) => (e as { autoEnabled?: boolean }).autoEnabled === true,
    );
    // The zero-cost path: a workspace with no auto evaluators pays one cheap
    // lookup per ingest and nothing else.
    if (auto.length === 0) return;

    // Group by trace BEFORE filtering. One OTLP batch routinely carries spans
    // from many traces, and `matchesFilter` is trace-level by contract ("some
    // span satisfies it"). Handing it the batch's whole span set lets a span
    // from trace A satisfy the filter on behalf of trace B — which defeats the
    // filter entirely, and at the default sampling=1 judges every non-matching
    // trace in the batch.
    const byTrace = new Map<string, Span[]>();
    for (const span of spans) {
      const group = byTrace.get(span.traceId);
      if (group === undefined) byTrace.set(span.traceId, [span]);
      else group.push(span);
    }

    for (const ev of auto) {
      const filter = ((ev as { filter?: unknown }).filter ?? []) as FilterClause[];
      const rate = (ev as { sampling?: number }).sampling ?? 1;

      for (const [traceId, traceSpans] of byTrace) {
        if (!matchesFilter(traceSpans, filter)) continue;

        // Sampling FIRST — before any statement. The order is the whole point:
        // a sampled-out job must never EXIST, not exist-then-vanish.
        const draw = (opts.draw ?? samplingDraw)(ev.id, traceId);
        if (!shouldSample(rate, draw)) continue;

        // `ON CONFLICT` makes dedup a DB invariant (ADR D4); the
        // `DO UPDATE ... WHERE claimed_at IS NULL` arm re-arms a still-queued
        // job for a trace that is still arriving (EC-6), while leaving a job
        // another worker already holds alone.
        await q.query(
          `INSERT INTO eval_jobs (workspace_id, evaluator_id, trace_id, run_after)
           VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)
           ON CONFLICT (workspace_id, evaluator_id, trace_id)
           DO UPDATE SET run_after = EXCLUDED.run_after
           WHERE eval_jobs.claimed_at IS NULL
             AND eval_jobs.created_at > now() - ($5 || ' seconds')::interval`,
          [workspaceId, ev.id, traceId, String(delaySeconds), String(rearmSeconds)],
        );
      }
    }
  };
}

/**
 * Start the daemon.
 *
 * Every claimed job carries its own `workspaceId` and it is threaded straight
 * into `runEvaluator` — never a default tenant (EC-5). Copying the retention /
 * M36 precedents verbatim here would be a silent cross-tenant leak.
 */
/**
 * Build the sweep dependencies the daemon runs on.
 *
 * Exported separately from `startAutoEval` so tests can drive the REAL closures
 * instead of re-implementing them. That distinction is not academic: an earlier
 * end-to-end test hand-rolled a copy of `runJob`, so the EC-5 workspace
 * threading it existed to prove was never actually exercised — and when the
 * `{ ran }` contract landed, the copy went stale while the suite stayed green.
 */
export function buildAutoEvalSweepDeps(
  q: Queryable,
  engine: EngineDeps,
  getEvaluator: (id: string, workspaceId: string) => Promise<EvaluatorRecord | null>,
  opts: {
    staleClaimMs?: number;
    batchSize?: number;
    concurrency?: number;
    workerId?: string;
  } = {},
): AutoEvalSweepDeps {
  const staleMs = opts.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS;
  const workerId = opts.workerId ?? `w-${process.pid}`;

  return {
    batchSize: opts.batchSize ?? DEFAULT_BATCH_SIZE,
    concurrency: opts.concurrency ?? RUN_CONCURRENCY,
    reclaim: () => reclaimStale(q, staleMs),
    claimNext: (limit) => claimNextJobs(q, workerId, limit, staleMs),
    // Refresh at a third of the stale window so two consecutive misses still
    // leave margin before another worker may take the job.
    heartbeatMs: Math.max(1_000, Math.floor(staleMs / 3)),
    heartbeat: async (job) => {
      try {
        await heartbeat(q, job.id, workerId);
      } catch (err) {
        autoEvalHeartbeatFailures.add(1);
        throw err; // the scheduler logs it; the counter makes it aggregatable
      }
    },
    runJob: async (job: ClaimedJob) => {
      const ev = await getEvaluator(job.evaluatorId, job.workspaceId);
      if (ev === null) {
        // The evaluator was deleted between enqueue and claim. Not an error —
        // there is nothing to run, and failing would burn the attempt budget on
        // a job that can never succeed. But it is NOT a completed evaluation
        // either: counting it as one would inflate the very metric the goal
        // rests on with work that never happened.
        return { ran: false };
      }
      await runEvaluator(ev, { traceIds: [job.traceId] }, job.workspaceId, engine);
      return { ran: true };
    },
    complete: async (job, ran) => {
      await completeJob(q, job.id, workerId);
      if (ran) {
        autoEvalJobsCompleted.add(1);
      } else {
        autoEvalJobsOrphaned.add(1);
      }
    },
    fail: async (job, reason) => {
      await failJob(q, job.id, reason, workerId);
      autoEvalJobsFailed.add(1);
    },
  };
}

/**
 * Start the daemon.
 *
 * Every claimed job carries its own `workspaceId` and it is threaded straight
 * into `runEvaluator` — never a default tenant (EC-5). Copying the retention /
 * M36 precedents verbatim here would be a silent cross-tenant leak.
 */
export function startAutoEval(
  q: Queryable,
  engine: EngineDeps,
  getEvaluator: (id: string, workspaceId: string) => Promise<EvaluatorRecord | null>,
  opts: {
    intervalMs?: number;
    staleClaimMs?: number;
    batchSize?: number;
    concurrency?: number;
    workerId?: string;
  } = {},
): AutoEvalSchedulerHandle {
  return startAutoEvalScheduler({
    intervalMs: opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
    ...buildAutoEvalSweepDeps(q, engine, getEvaluator, opts),
  });
}
