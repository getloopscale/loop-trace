import { describe, it, expect, vi } from "vitest";
import { startRetentionScheduler } from "./retention-scheduler.js";

/** A fake interval that captures the tick callback so the test drives ticks. */
function fakeTimer() {
  let cb: (() => void) | null = null;
  let cleared = false;
  return {
    setIntervalFn: (fn: () => void) => {
      cb = fn;
      return { id: 1 };
    },
    clearIntervalFn: () => {
      cleared = true;
    },
    tick: () => cb?.(),
    get cleared() {
      return cleared;
    },
  };
}

/** A deferred promise for controlling when a sweep resolves. */
function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("startRetentionScheduler (M23)", () => {
  it("scheduler_runs_prune_on_tick", async () => {
    const timer = fakeTimer();
    const runOnce = vi.fn().mockResolvedValue(undefined);
    startRetentionScheduler({
      runOnce,
      intervalMs: 1000,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      log: () => {},
    });
    timer.tick();
    await flush();
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it("scheduler_skips_overlapping_sweep", async () => {
    const timer = fakeTimer();
    const d = deferred();
    const runOnce = vi.fn().mockReturnValueOnce(d.promise).mockResolvedValue(undefined);
    startRetentionScheduler({
      runOnce,
      intervalMs: 1000,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      log: () => {},
    });
    timer.tick(); // sweep 1 starts, stays in-flight (pending promise)
    timer.tick(); // fires while sweeping → must be SKIPPED (overlap guard)
    await flush();
    expect(runOnce).toHaveBeenCalledTimes(1); // not 2 — the guard held
    d.resolve(); // sweep 1 completes
    await flush();
    timer.tick(); // now a fresh sweep runs
    await flush();
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it("scheduler_isolates_sweep_error", async () => {
    const timer = fakeTimer();
    const runOnce = vi
      .fn()
      .mockRejectedValueOnce(new Error("DB down"))
      .mockResolvedValue(undefined);
    const log = vi.fn();
    startRetentionScheduler({
      runOnce,
      intervalMs: 1000,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      log,
    });
    timer.tick(); // sweep rejects
    await flush();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ level: "error", msg: "retention sweep failed" }),
    );
    // the scheduler survived — a later tick still runs
    timer.tick();
    await flush();
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it("scheduler_stop_clears_interval", () => {
    const timer = fakeTimer();
    const { stop } = startRetentionScheduler({
      runOnce: vi.fn().mockResolvedValue(undefined),
      intervalMs: 1000,
      setIntervalFn: timer.setIntervalFn,
      clearIntervalFn: timer.clearIntervalFn,
      log: () => {},
    });
    stop();
    expect(timer.cleared).toBe(true);
  });
});
