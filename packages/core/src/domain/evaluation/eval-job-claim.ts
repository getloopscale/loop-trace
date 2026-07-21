/**
 * M134 T3.1 — the auto-evaluation claim protocol (ADR D1).
 *
 * The `eval_jobs` table IS the queue. A worker takes work with a conditional
 * `UPDATE … RETURNING`, refreshes its claim with a heartbeat while running, and
 * an orphan scan frees claims whose worker died. No broker, no new
 * infrastructure, and — unlike both Redis-backed alternatives surveyed in the
 * blueprint — accepted work cannot be lost, because the work state IS the
 * database state.
 *
 * The claim is an optimistic CAS, NOT `FOR UPDATE SKIP LOCKED`. The distinction
 * matters and is load-bearing: see `claimNextJobs` below.
 */

/** Minimal query surface, so this module is testable against a pool or a tx. */
export interface Queryable {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export interface ClaimedJob {
  id: string;
  workspaceId: string;
  evaluatorId: string;
  traceId: string;
  attempts: number;
}

/**
 * How many times a job may be claimed before it is parked as `failed`.
 *
 * EC-8: without a budget, a deterministically failing job — a misconfigured
 * judge, a permanently 401 provider, a filter typo — is claimed, fails, goes
 * stale, and is reclaimed on every sweep forever. Because the claim loop is
 * global, that livelock competes with every other tenant's work. This is
 * blueprint AP-4 (rows stranded with no sweeper) inverted: a sweeper with no
 * terminal state is just as bad.
 */
export const MAX_ATTEMPTS = 3;

/** Terminal statuses — never claimed again. */
const TERMINAL = ["done", "failed"] as const;

function toClaimedJob(r: Record<string, unknown>): ClaimedJob {
  return {
    id: String(r["id"]),
    workspaceId: String(r["workspace_id"]),
    evaluatorId: String(r["evaluator_id"]),
    traceId: String(r["trace_id"]),
    attempts: Number(r["attempts"]),
  };
}

/**
 * Claim up to `limit` runnable jobs for `workerId`.
 *
 * A job is runnable when it is not terminal, its `run_after` gate has elapsed,
 * it is under the attempt budget, and it is either unclaimed or its claim has
 * gone stale.
 *
 * **The claim predicate is repeated in the OUTER `WHERE`, deliberately.** The
 * inner `SELECT` only chooses candidates; it does not decide the race. Under
 * READ COMMITTED, when two workers target the same row, the loser blocks on the
 * row lock and then RE-EVALUATES the outer `WHERE` against the version the
 * winner just committed — where `claimed_at` is now fresh, so the predicate is
 * false and the row is not updated. Filtering only in the subquery would let
 * both workers claim, double-scoring the trace and double-incrementing
 * `attempts`. `test_two_workers_racing_claim_same_row_yields_one_winner` is the
 * assertion that pins this; every other test in the suite passes either way.
 */
export async function claimNextJobs(
  q: Queryable,
  workerId: string,
  limit: number,
  staleAfterMs: number,
): Promise<ClaimedJob[]> {
  const staleSeconds = Math.max(0, Math.floor(staleAfterMs / 1000));
  const { rows } = await q.query(
    `UPDATE eval_jobs SET
       status = 'running',
       claimed_by = $1,
       claimed_at = now(),
       attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM eval_jobs
       WHERE status <> ALL($2::text[])
         AND run_after <= now()
         AND attempts < $3
         AND (claimed_at IS NULL OR claimed_at < now() - ($4 || ' seconds')::interval)
       ORDER BY run_after
       LIMIT $5
     )
       -- Re-checked under the row lock. THIS is the compare-and-swap.
       AND (claimed_at IS NULL OR claimed_at < now() - ($4 || ' seconds')::interval)
     RETURNING id, workspace_id, evaluator_id, trace_id, attempts`,
    [workerId, TERMINAL, MAX_ATTEMPTS, String(staleSeconds), limit],
  );
  return rows.map(toClaimedJob);
}

/**
 * Refresh a claim so a long-running job is not stolen mid-flight.
 *
 * Scoped to the owning worker: a worker that already lost the row to the
 * reclaim path must not be able to silently take it back, because another
 * worker may already be running it.
 *
 * Returns whether the claim was still ours.
 */
export async function heartbeat(
  q: Queryable,
  traceIdOrJobId: string,
  workerId: string,
): Promise<boolean> {
  const { rowCount } = await q.query(
    `UPDATE eval_jobs SET claimed_at = now()
     WHERE (id::text = $1 OR trace_id = $1)
       AND claimed_by = $2
       AND status = 'running'`,
    [traceIdOrJobId, workerId],
  );
  return (rowCount ?? 0) > 0;
}

/** Mark a job done. Terminal — no sweep picks it up again. */
export async function completeJob(q: Queryable, jobId: string): Promise<void> {
  await q.query(
    `UPDATE eval_jobs SET status = 'done', claimed_by = NULL, claimed_at = NULL
     WHERE id = $1`,
    [jobId],
  );
}

/**
 * Record a failure.
 *
 * Under the attempt budget the job returns to `queued` with the reason stored,
 * so the next sweep retries it. At the budget it is parked as `failed` —
 * terminal — which is what stops EC-8's livelock. The reason is persisted
 * either way: the plan's Failure-scenarios table promised "job marked failed
 * with reason" while v1.0 of the schema had nowhere to put one.
 */
export async function failJob(
  q: Queryable,
  jobId: string,
  reason: string,
): Promise<void> {
  await q.query(
    `UPDATE eval_jobs SET
       status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'queued' END,
       last_error = $3,
       claimed_by = NULL,
       claimed_at = NULL
     WHERE id = $1`,
    [jobId, MAX_ATTEMPTS, reason],
  );
}

/**
 * Free claims whose worker died, returning them to `queued`.
 *
 * `claimNextJobs` already treats a stale claim as claimable, so this is not
 * strictly required for liveness — but running it explicitly keeps the table
 * honest (a crashed worker's rows read `queued`, not a phantom `running`) and
 * gives the daemon a number worth logging.
 */
export async function reclaimStale(
  q: Queryable,
  staleAfterMs: number,
): Promise<number> {
  const staleSeconds = Math.max(0, Math.floor(staleAfterMs / 1000));
  const { rowCount } = await q.query(
    `UPDATE eval_jobs SET status = 'queued', claimed_by = NULL, claimed_at = NULL
     WHERE status = 'running'
       AND claimed_at IS NOT NULL
       AND claimed_at < now() - ($1 || ' seconds')::interval`,
    [String(staleSeconds)],
  );
  return rowCount ?? 0;
}
