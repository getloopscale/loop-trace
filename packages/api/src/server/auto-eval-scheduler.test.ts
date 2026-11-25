import { describe, expect, it, vi } from "vitest";
import type { ClaimedJob } from "@looptrace/core";

import {
  startAutoEvalScheduler,
  sweepOnce,
  type AutoEvalSweepDeps,
} from "./auto-eval-scheduler.js";

/**
 * M134 T4.1 — the auto-evaluation daemon.
 *
 * Its LIFECYCLE mirrors `retention-scheduler.ts` (overlap guard, error
 * isolation, `unref()`'d timer, injected timer) because that shape is already
 * proven here. Its WORKSPACE HANDLING must NOT mirror it: both existing daemons
 * in this repo are single-workspace and the M36 eval sweep literally passes
 * `DEFAULT_WORKSPACE_ID`. This loop claims across every tenant (EC-5).
 */

function job(over: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: "j1",
    workspaceId: "ws-a",
    evaluatorId: "e1",
    traceId: "t1",
    attempts: 1,
    ...over,
  };
}

function deps(over: Partial<AutoEvalSweepDeps> = {}): AutoEvalSweepDeps {
  return {
    claimNext: vi.fn(async () => []),
    runJob: vi.fn(async () => ({ ran: true })),
    complete: vi.fn(async () => {}),
    fail: vi.fn(async () => {}),
    reclaim: vi.fn(async () => 0),
    batchSize: 10,
    concurrency: 4,
    ...over,
  };
}

describe("sweepOnce (M134 T4.1)", () => {
  it("test_claimed_jobs_are_run_and_completed", async () => {
    const d = deps({ claimNext: vi.fn(async () => [job(), job({ id: "j2" })]) });

    await sweepOnce(d);

    expect(d.runJob).toHaveBeenCalledTimes(2);
    expect(d.complete).toHaveBeenCalledTimes(2);
    expect(d.fail).not.toHaveBeenCalled();
  });

  it("test_job_from_workspace_b_is_run_with_workspace_b", async () => {
    // EC-5 — the cross-tenant leak this guards. If the daemon dropped the
    // workspace from the claimed row and used a default, workspace B's trace
    // would be scored with workspace A's evaluators and the verdict written
    // under the wrong tenant. It would do so SILENTLY, because the verdict
    // table is workspace-leading, so the wrong-tenant row inserts cleanly.
    const seen: string[] = [];
    const d = deps({
      claimNext: vi.fn(async () => [
        job({ id: "a", workspaceId: "ws-a" }),
        job({ id: "b", workspaceId: "ws-b" }),
      ]),
      runJob: vi.fn(async (j: ClaimedJob) => {
        seen.push(j.workspaceId);
        return { ran: true };
      }),
    });

    await sweepOnce(d);

    expect(seen.sort()).toEqual(["ws-a", "ws-b"]);
  });

  it("test_a_failing_job_is_recorded_and_does_not_abort_its_siblings", async () => {
    const d = deps({
      claimNext: vi.fn(async () => [job({ id: "ok" }), job({ id: "bad" })]),
      runJob: vi.fn(async (j: ClaimedJob) => {
        if (j.id === "bad") throw new Error("judge exploded");
        return { ran: true };
      }),
    });

    await sweepOnce(d);

    expect(d.complete).toHaveBeenCalledTimes(1);
    expect(d.fail).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bad" }),
      expect.stringContaining("judge exploded"),
    );
  });

  it("test_bounded_concurrency_is_respected", async () => {
    // Reuses M133's mapPool rather than a second cap. An atomic-counter
    // invariant around the stubbed work asserts peak in-flight never exceeds
    // the configured concurrency — two independent caps would multiply, and
    // the judge fan-out is the expensive thing being capped.
    let inFlight = 0;
    let peak = 0;
    const d = deps({
      concurrency: 3,
      claimNext: vi.fn(async () =>
        Array.from({ length: 12 }, (_, i) => job({ id: `j${i}` })),
      ),
      runJob: vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { ran: true };
      }),
    });

    await sweepOnce(d);

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1); // proves it is actually parallel
  });

  it("test_a_job_that_did_not_run_is_not_counted_as_completed", async () => {
    // The milestone's own success metric is `autoEvalJobsCompleted > 0`. If a
    // job whose evaluator was deleted between enqueue and claim is reported as
    // completed, that metric counts work which never happened — the one number
    // the goal rests on becomes untrustworthy. `ran: false` must reach
    // `complete` so the caller can settle the row WITHOUT claiming a score.
    const completions: boolean[] = [];
    const d = deps({
      claimNext: vi.fn(async () => [job()]),
      runJob: vi.fn(async () => ({ ran: false })),
      complete: vi.fn(async (_job: ClaimedJob, ran: boolean) => {
        completions.push(ran);
      }),
    });

    await sweepOnce(d);

    // Settled (the row must not be re-claimed forever) but NOT counted as a run.
    expect(d.complete).toHaveBeenCalledTimes(1);
    expect(completions).toEqual([false]);
  });

  it("test_a_job_that_ran_is_reported_as_having_run", async () => {
    const completions: boolean[] = [];
    const d = deps({
      claimNext: vi.fn(async () => [job()]),
      runJob: vi.fn(async () => ({ ran: true })),
      complete: vi.fn(async (_job: ClaimedJob, ran: boolean) => {
        completions.push(ran);
      }),
    });

    await sweepOnce(d);

    expect(completions).toEqual([true]);
  });

  it("test_an_in_flight_job_is_heartbeaten_until_it_finishes", async () => {
    // F-wire-2 (review). Without this, a job outliving the stale window is
    // reclaimed and re-run WHILE STILL RUNNING — duplicate judge spend on the
    // exact path this milestone exists to bound.
    const beats: string[] = [];
    let release: (() => void) | undefined;
    const d = deps({
      claimNext: vi.fn(async () => [job()]),
      heartbeatMs: 5,
      heartbeat: vi.fn(async (j: ClaimedJob) => {
        beats.push(j.id);
      }),
      runJob: vi.fn(
        () =>
          new Promise<{ ran: boolean }>((res) => {
            release = () => res({ ran: true });
          }),
      ),
    });

    const sweep = sweepOnce(d);
    await new Promise((r) => setTimeout(r, 24));
    expect(beats.length).toBeGreaterThanOrEqual(2);

    release?.();
    await sweep;

    // And it STOPS once the job settles — a leaked timer would keep refreshing
    // a claim nobody holds.
    const after = beats.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(beats.length).toBe(after);
  });

  it("test_heartbeat_timer_is_cleared_even_when_the_job_throws", async () => {
    const beats: string[] = [];
    const d = deps({
      claimNext: vi.fn(async () => [job()]),
      heartbeatMs: 5,
      heartbeat: vi.fn(async (j: ClaimedJob) => {
        beats.push(j.id);
      }),
      runJob: vi.fn(async () => {
        throw new Error("judge exploded");
      }),
    });

    await sweepOnce(d);
    const after = beats.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(beats.length).toBe(after);
  });

  it("test_a_failed_heartbeat_is_surfaced_not_swallowed", async () => {
    // Self-review catch. The first version caught and discarded the rejection
    // with a comment arguing "the worst case is the reclaim it was preventing"
    // — but that reclaim IS the failure: the trace gets judged twice. That is
    // blueprint AP-3, the exact pattern this milestone counted on the enqueue
    // path before repeating it here.
    const logs: Record<string, unknown>[] = [];
    let release: (() => void) | undefined;
    const d = deps({
      claimNext: vi.fn(async () => [job()]),
      heartbeatMs: 5,
      heartbeat: vi.fn(async () => {
        throw new Error("db unreachable");
      }),
      log: (e) => logs.push(e),
      runJob: vi.fn(
        () =>
          new Promise<{ ran: boolean }>((res) => {
            release = () => res({ ran: true });
          }),
      ),
    });

    const sweep = sweepOnce(d);
    await new Promise((r) => setTimeout(r, 18));
    release?.();
    await sweep;

    const beats = logs.filter((l) => l["msg"] === "auto_eval_heartbeat_failed");
    expect(beats.length).toBeGreaterThanOrEqual(1);
    expect(beats[0]!["jobId"]).toBe("j1");
    // A failing heartbeat must NOT take the job down with it.
    expect(d.complete).toHaveBeenCalledTimes(1);
    expect(d.fail).not.toHaveBeenCalled();
  });

  it("test_stale_claims_are_reclaimed_before_claiming", async () => {
    const order: string[] = [];
    const d = deps({
      reclaim: vi.fn(async () => {
        order.push("reclaim");
        return 2;
      }),
      claimNext: vi.fn(async () => {
        order.push("claim");
        return [];
      }),
    });

    await sweepOnce(d);

    expect(order).toEqual(["reclaim", "claim"]);
  });

  it("test_empty_claim_does_no_work", async () => {
    const d = deps();
    await sweepOnce(d);
    expect(d.runJob).not.toHaveBeenCalled();
  });
});

describe("startAutoEvalScheduler lifecycle (M134 T4.1)", () => {
  function fakeTimer() {
    let cb: (() => void) | undefined;
    return {
      setIntervalFn: (fn: () => void) => {
        cb = fn;
        return { unref: vi.fn() };
      },
      clearIntervalFn: vi.fn(),
      tick: () => cb?.(),
    };
  }

  it("test_tick_while_sweeping_is_skipped", async () => {
    // Overlap guard: two concurrent sweeps would both claim and both run.
    const t = fakeTimer();
    let release: (() => void) | undefined;
    const d = deps({
      claimNext: vi.fn(async () => [job()]),
      runJob: vi.fn(
        () => new Promise<{ ran: boolean }>((res) => { release = () => res({ ran: true }); }),
      ),
    });

    startAutoEvalScheduler({
      ...d,
      intervalMs: 10,
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
    });

    t.tick();
    await Promise.resolve();
    t.tick(); // second tick while the first is still in flight
    await Promise.resolve();

    expect(d.claimNext).toHaveBeenCalledTimes(1);
    release?.();
  });

  it("test_failing_sweep_does_not_stop_the_scheduler", async () => {
    const t = fakeTimer();
    const logs: Record<string, unknown>[] = [];
    const d = deps({
      claimNext: vi.fn(async () => {
        throw new Error("db down");
      }),
    });

    startAutoEvalScheduler({
      ...d,
      intervalMs: 10,
      log: (e) => logs.push(e),
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
    });

    t.tick();
    await new Promise((r) => setTimeout(r, 5));
    t.tick();
    await new Promise((r) => setTimeout(r, 5));

    // Two ticks both attempted — the first failure did not kill the loop.
    expect(d.claimNext).toHaveBeenCalledTimes(2);
    expect(logs.some((l) => l["level"] === "error")).toBe(true);
  });

  it("test_stop_clears_the_timer", () => {
    const t = fakeTimer();
    const handle = startAutoEvalScheduler({
      ...deps(),
      intervalMs: 10,
      setIntervalFn: t.setIntervalFn,
      clearIntervalFn: t.clearIntervalFn,
    });

    handle.stop();

    expect(t.clearIntervalFn).toHaveBeenCalled();
  });

  it("test_timer_is_unrefd_so_it_never_blocks_process_exit", () => {
    const unref = vi.fn();
    startAutoEvalScheduler({
      ...deps(),
      intervalMs: 10,
      setIntervalFn: () => ({ unref }),
      clearIntervalFn: vi.fn(),
    });

    expect(unref).toHaveBeenCalled();
  });
});
