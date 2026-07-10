/**
 * M94 — graceful shutdown. On SIGTERM/SIGINT (a rolling deploy / pod eviction): stop timers, stop
 * accepting new connections, drain in-flight requests within a bounded deadline, close the DB pool,
 * then exit. Without this, every deploy severs in-flight requests and leaks connections. Extracted
 * (not inlined in `main()`) so the ordering + deadline are unit-testable with injected deps.
 */

export interface ShutdownDeps {
  /** The http.Server (from @hono/node-server `serve`) — `close` stops accepting new connections. */
  server: { close: (cb?: (err?: Error) => void) => void };
  /** The pg pool — drained after in-flight requests settle. */
  pool: { end: () => Promise<void> };
  /** Clears the background timers (retention/eval sweep) — from `bootstrap`. */
  stop: () => void;
  /** Max ms to await in-flight requests before a forced close. */
  drainMs: number;
  /** Injected exit (default process.exit) — overridden in tests. */
  exit?: (code: number) => void;
  /** Injected timer (default setTimeout) — overridden in tests. */
  setTimer?: (cb: () => void, ms: number) => { unref?: () => void };
  logger?: (entry: Record<string, unknown>) => void;
}

/**
 * Run the shutdown sequence once. Idempotent-safe by the caller (install guards re-entry). Resolves
 * after the pool is closed and `exit` is called — never rejects (a drain/close error is logged, then
 * the process still exits so a stuck resource cannot block the deploy).
 */
export async function gracefulShutdown(deps: ShutdownDeps): Promise<void> {
  const log = deps.logger ?? ((e) => console.error(JSON.stringify(e)));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));

  log({ level: "info", msg: "shutdown: draining" });
  deps.stop(); // clear background timers first

  // Stop accepting new connections; resolve when existing ones settle OR the drain deadline elapses.
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    deps.server.close(() => done()); // fires when all in-flight requests have finished
    const t = setTimer(() => {
      log({ level: "warn", msg: "shutdown: drain deadline reached, forcing close" });
      done();
    }, deps.drainMs);
    t.unref?.();
  });

  try {
    await deps.pool.end();
    log({ level: "info", msg: "shutdown: pool closed" });
  } catch (err) {
    log({ level: "error", msg: "shutdown: pool.end failed", error: err instanceof Error ? err.message : String(err) });
  }
  exit(0);
}

/** Register the SIGTERM/SIGINT handlers (once). A second signal during shutdown is ignored. */
export function installGracefulShutdown(deps: ShutdownDeps): void {
  let shuttingDown = false;
  const handler = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void gracefulShutdown(deps);
  };
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
}
