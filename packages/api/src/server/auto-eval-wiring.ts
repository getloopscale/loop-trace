import {
  claimNextJobs,
  completeJob,
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
} from "@usetheo/lens-core";

import {
  startAutoEvalScheduler,
  type AutoEvalSchedulerHandle,
} from "./auto-eval-scheduler.js";
import { autoEvalJobsCompleted, autoEvalJobsFailed } from "./metrics.js";

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
 * Build the ingest-side hook: for every auto-enabled evaluator whose filter the
 * trace matches and which survives sampling, insert one job row.
 *
 * Ordering is load-bearing and matches the reference: **dedup (the unique
 * constraint) → sample → insert**. Sampling before dedup would re-roll the dice
 * on every OTLP batch of the same trace, so a 10 % evaluator would converge on
 * 100 % inclusion; sampling after insert would strand rows for jobs that never run.
 *
 * A re-ingest of a trace whose job is still queued pushes `run_after` out
 * (EC-6), so a trace still streaming is scored once, on its full span set,
 * rather than once on whatever arrived first. Once claimed, the row is left
 * alone — otherwise a busy stream would starve its own evaluation.
 */
export function makeEnqueueAutoEval(
  q: Queryable,
  listEvaluators: (workspaceId: string) => Promise<EvaluatorRecord[]>,
  opts: { delayMs?: number; random?: () => number } = {},
): (spans: Span[], workspaceId: string) => Promise<void> {
  const delaySeconds = Math.max(0, Math.floor((opts.delayMs ?? 5_000) / 1000));

  return async (spans, workspaceId) => {
    if (spans.length === 0) return;

    const evaluators = await listEvaluators(workspaceId);
    const auto = evaluators.filter(
      (e) => (e as { autoEnabled?: boolean }).autoEnabled === true,
    );
    // The zero-cost path: a workspace with no auto evaluators pays one cheap
    // lookup per ingest and nothing else.
    if (auto.length === 0) return;

    const traceIds = [...new Set(spans.map((s) => s.traceId))];

    for (const ev of auto) {
      const filter = ((ev as { filter?: unknown }).filter ?? []) as FilterClause[];
      if (!matchesFilter(spans, filter)) continue;

      const rate = (ev as { sampling?: number }).sampling ?? 1;

      for (const traceId of traceIds) {
        // `ON CONFLICT DO NOTHING` makes dedup a DB invariant (ADR D4); the
        // `DO UPDATE ... WHERE claimed_at IS NULL` arm re-arms a still-queued
        // job for a trace that is still arriving (EC-6).
        const inserted = await q.query(
          `INSERT INTO eval_jobs (workspace_id, evaluator_id, trace_id, run_after)
           VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)
           ON CONFLICT (workspace_id, evaluator_id, trace_id)
           DO UPDATE SET run_after = EXCLUDED.run_after
           WHERE eval_jobs.claimed_at IS NULL
           RETURNING id, (xmax = 0) AS is_new`,
          [workspaceId, ev.id, traceId, String(delaySeconds)],
        );

        // Sampling is decided ONCE per (evaluator, trace) — only on the insert
        // that actually created the row. A re-arm must not re-roll.
        const isNew = inserted.rows[0]?.["is_new"] === true;
        if (isNew && !shouldSample(rate, opts.random?.())) {
          await q.query(`DELETE FROM eval_jobs WHERE id = $1`, [
            inserted.rows[0]!["id"],
          ]);
        }
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
  const staleMs = opts.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS;
  const workerId = opts.workerId ?? `w-${process.pid}`;

  return startAutoEvalScheduler({
    intervalMs: opts.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS,
    batchSize: opts.batchSize ?? DEFAULT_BATCH_SIZE,
    concurrency: opts.concurrency ?? RUN_CONCURRENCY,
    reclaim: () => reclaimStale(q, staleMs),
    claimNext: (limit) => claimNextJobs(q, workerId, limit, staleMs),
    runJob: async (job: ClaimedJob) => {
      const ev = await getEvaluator(job.evaluatorId, job.workspaceId);
      if (ev === null) {
        // The evaluator was deleted after the job was queued. Not an error —
        // there is simply nothing to run. Failing loudly here would burn the
        // attempt budget on a job that can never succeed.
        return;
      }
      await runEvaluator(ev, { traceIds: [job.traceId] }, job.workspaceId, engine);
    },
    complete: async (job) => {
      await completeJob(q, job.id);
      autoEvalJobsCompleted.add(1);
    },
    fail: async (job, reason) => {
      await failJob(q, job.id, reason);
      autoEvalJobsFailed.add(1);
    },
  });
}
