/**
 * Opt-in in-process retention sweep (M23). Runs `runOnce` on a fixed interval with
 * three guarantees (Rule 8 — a background destructive op must be safe):
 *   - overlap guard: a tick that fires while a sweep is still in flight is skipped
 *     (never two concurrent prunes / DB transactions);
 *   - error isolation: a failing sweep is logged and the scheduler keeps running —
 *     a prune error never crashes the server;
 *   - no leaked timer: the interval is `unref()`'d (never blocks process exit) and
 *     `stop()` clears it (tests + graceful shutdown).
 * The timer + clock are injectable so tests drive ticks deterministically.
 */
export interface RetentionSchedulerDeps {
  runOnce: () => Promise<void>;
  intervalMs: number;
  log?: (entry: Record<string, unknown>) => void;
  setIntervalFn?: (cb: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
}

export interface RetentionSchedulerHandle {
  stop: () => void;
}

export function startRetentionScheduler(
  deps: RetentionSchedulerDeps,
): RetentionSchedulerHandle {
  const log = deps.log ?? ((e) => console.error(JSON.stringify(e)));
  const setI = deps.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
  const clearI = deps.clearIntervalFn ?? ((h) => clearInterval(h as NodeJS.Timeout));

  let sweeping = false;
  const tick = async (): Promise<void> => {
    if (sweeping) {
      log({ level: "debug", msg: "retention sweep skipped — previous still running" });
      return;
    }
    sweeping = true;
    try {
      await deps.runOnce();
    } catch (err) {
      log({
        level: "error",
        msg: "retention sweep failed",
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
