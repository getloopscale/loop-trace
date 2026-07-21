import { mapPool, type ClaimedJob } from "@usetheo/lens-core";

/**
 * M134 T4.1 — the in-process auto-evaluation daemon.
 *
 * Its LIFECYCLE deliberately mirrors `retention-scheduler.ts`: overlap guard,
 * error isolation, `unref()`'d timer, injected timer for deterministic tests.
 * That shape is already proven and covered in this repo, so copying it is
 * cheaper and safer than inventing a second daemon idiom.
 *
 * Its WORKSPACE HANDLING deliberately does NOT mirror it. Both existing
 * in-process daemons here are single-workspace — retention is system-wide by
 * design, and the M36 eval sweep passes `DEFAULT_WORKSPACE_ID` outright. This
 * loop claims across every tenant, so each job's workspace comes off the
 * claimed ROW. Copying the precedent verbatim would score workspace B's traces
 * with workspace A's evaluators and write verdicts under the wrong tenant —
 * silently, because the verdict table is workspace-leading, so the wrong-tenant
 * row inserts cleanly instead of colliding. That is a cross-tenant leak, not a
 * bug (plan EC-5).
 */

/** What one sweep needs. Every side effect is injected, so the sweep is pure to test. */
export interface AutoEvalSweepDeps {
  /** Free claims whose worker died, then claim up to `batchSize` runnable jobs. */
  reclaim: () => Promise<number>;
  claimNext: (limit: number) => Promise<ClaimedJob[]>;
  /**
   * Score the job. MUST use `job.workspaceId` — never a default tenant (EC-5).
   *
   * Returns whether evaluation actually RAN. A job whose evaluator was deleted
   * between enqueue and claim has nothing to run; it must still be settled so
   * it is not re-claimed forever, but reporting it as a completed evaluation
   * would inflate the milestone's own success metric with work that never
   * happened.
   */
  runJob: (job: ClaimedJob) => Promise<{ ran: boolean }>;
  /** Settle the job. `ran` distinguishes "scored" from "nothing to score". */
  complete: (job: ClaimedJob, ran: boolean) => Promise<void>;
  /**
   * Refresh the claim on an in-flight job.
   *
   * Without it a job that outlives the stale window is reclaimed and re-run
   * WHILE STILL RUNNING — duplicate judge spend on the exact path the milestone
   * exists to bound, and a burned attempt budget. That window is reachable: one
   * trace's spans judged at RUN_CONCURRENCY against a slow provider can exceed
   * two minutes.
   */
  heartbeat?: (job: ClaimedJob) => Promise<void>;
  /** Gap between heartbeats. Must be well under the stale-claim window. */
  heartbeatMs?: number;
  fail: (job: ClaimedJob, reason: string) => Promise<void>;
  batchSize: number;
  /** Cap on concurrent judge fan-out. Reuses M133's `RUN_CONCURRENCY` by default. */
  concurrency: number;
  log?: (entry: Record<string, unknown>) => void;
}

export interface AutoEvalSchedulerDeps extends AutoEvalSweepDeps {
  intervalMs: number;
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface AutoEvalSchedulerHandle {
  stop: () => void;
}

/**
 * One sweep: reclaim stale claims, take a batch, run it under a concurrency cap.
 *
 * Reclaim runs FIRST so a worker that died since the last tick has its rows
 * returned to the pool before this tick decides what to take — otherwise a
 * crashed worker's work waits an extra full interval for no reason.
 *
 * A job that throws is recorded and does NOT abort its siblings. One bad
 * evaluator config must not stall every other tenant's work sharing the sweep.
 */
export async function sweepOnce(deps: AutoEvalSweepDeps): Promise<void> {
  const log = deps.log ?? (() => {});

  const reclaimed = await deps.reclaim();
  if (reclaimed > 0) {
    log({ level: "info", msg: "auto_eval_reclaimed_stale_jobs", count: reclaimed });
  }

  const jobs = await deps.claimNext(deps.batchSize);
  if (jobs.length === 0) return;

  await mapPool(jobs, deps.concurrency, async (job) => {
    // Keep the claim fresh for as long as this job runs. The interval is
    // cleared in `finally` so a throwing job cannot leak a timer.
    const beat = deps.heartbeat;
    const timer =
      beat === undefined
        ? undefined
        : setInterval(() => {
            void beat(job).catch((err: unknown) => {
              // A missed refresh is not fatal to THIS job — it keeps running.
              // But it is the precondition for the failure the heartbeat exists
              // to prevent: the claim goes stale, another worker reclaims, and
              // the trace is judged twice. Swallowing it with no signal is
              // exactly blueprint AP-3, which this milestone already counted on
              // the enqueue path. Surface it in both places.
              log({
                level: "warn",
                msg: "auto_eval_heartbeat_failed",
                jobId: job.id,
                workspaceId: job.workspaceId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
          }, deps.heartbeatMs ?? 30_000);

    try {
      const { ran } = await deps.runJob(job);
      await deps.complete(job, ran);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Recorded on the row (with an attempt budget behind it), not just logged —
      // a failure nobody can read is indistinguishable from work never claimed.
      await deps.fail(job, reason);
      log({
        level: "error",
        msg: "auto_eval_job_failed",
        jobId: job.id,
        workspaceId: job.workspaceId,
        attempts: job.attempts,
        error: reason,
      });
    } finally {
      if (timer !== undefined) clearInterval(timer);
    }
  });
}

/**
 * Start the sweep on a fixed interval.
 *
 * Three guarantees, all inherited from the retention precedent:
 *  - **overlap guard** — a tick that fires while a sweep is in flight is
 *    skipped; two concurrent sweeps would both claim and both run;
 *  - **error isolation** — a failing sweep is logged and the loop continues; a
 *    transient DB error must not silently stop auto-evaluation for the process
 *    lifetime;
 *  - **no leaked timer** — the interval is `unref()`'d so it never blocks
 *    process exit, and `stop()` clears it.
 */
export function startAutoEvalScheduler(
  deps: AutoEvalSchedulerDeps,
): AutoEvalSchedulerHandle {
  const log = deps.log ?? ((e) => console.error(JSON.stringify(e)));
  const setI = deps.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
  const clearI =
    deps.clearIntervalFn ?? ((h) => clearInterval(h as NodeJS.Timeout));

  let sweeping = false;
  const tick = async (): Promise<void> => {
    if (sweeping) {
      log({ level: "debug", msg: "auto_eval_sweep_skipped_still_running" });
      return;
    }
    sweeping = true;
    try {
      await sweepOnce({ ...deps, log });
    } catch (err) {
      log({
        level: "error",
        msg: "auto_eval_sweep_failed",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      sweeping = false;
    }
  };

  const handle = setI(() => void tick(), deps.intervalMs);
  if (
    handle != null &&
    typeof (handle as { unref?: () => void }).unref === "function"
  ) {
    (handle as { unref: () => void }).unref();
  }
  return { stop: () => clearI(handle) };
}
