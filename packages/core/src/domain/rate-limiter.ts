/** Sweep expired windows once the map grows past this many entries (bounded memory). */
const SWEEP_THRESHOLD = 1024;

/**
 * M33 — per-workspace fixed-window rate limiter (D3). Pure + clock-injected (the
 * caller passes `nowMs`) so time-based behavior is deterministically testable
 * (`testing.md` § 6). In-process / single-node — a distributed limiter is a follow-up
 * (documented in ADR D3). `tryAcquire` is a synchronous Map mutation; on Node's
 * single-threaded event loop it is atomic per call (no Lost Update).
 *
 * Memory: keyed by resolved-Principal workspaceId (never attacker-chosen free text),
 * so the map is bounded by the tenant count. To keep that bound tight over a long
 * process lifetime, expired windows are opportunistically swept once the map exceeds
 * {@link SWEEP_THRESHOLD} — O(1) on the common path, O(n) only when it has grown large.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly rpm: number,
    private readonly windowMs = 60_000,
  ) {}

  /**
   * Returns true if the request is allowed (and counts it), false if the workspace
   * has hit `rpm` within the current window. A new/expired window resets the count.
   */
  tryAcquire(workspaceId: string, nowMs: number): boolean {
    const w = this.windows.get(workspaceId);
    if (w === undefined || nowMs - w.start >= this.windowMs) {
      if (this.windows.size >= SWEEP_THRESHOLD) this.sweepExpired(nowMs);
      this.windows.set(workspaceId, { start: nowMs, count: 1 });
      return true;
    }
    if (w.count < this.rpm) {
      w.count += 1;
      return true;
    }
    return false;
  }

  /** Drop windows whose fixed window has fully elapsed — prevents unbounded growth. */
  private sweepExpired(nowMs: number): void {
    for (const [ws, w] of this.windows) {
      if (nowMs - w.start >= this.windowMs) this.windows.delete(ws);
    }
  }

  /**
   * M94 — seconds until this workspace's current window resets, for the `Retry-After` 429 header.
   * `ceil` so a sub-second remainder rounds up to 1 (never advise 0). An unknown/expired window → 0.
   */
  retryAfterSeconds(workspaceId: string, nowMs: number): number {
    const w = this.windows.get(workspaceId);
    if (w === undefined) return 0;
    const remainingMs = w.start + this.windowMs - nowMs;
    return remainingMs <= 0 ? 0 : Math.ceil(remainingMs / 1000);
  }

  /** Number of tracked windows — exposed so the memory bound is assertable in tests. */
  get size(): number {
    return this.windows.size;
  }
}
