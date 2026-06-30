/**
 * M33 — per-workspace fixed-window rate limiter (D3). Pure + clock-injected (the
 * caller passes `nowMs`) so time-based behavior is deterministically testable
 * (`testing.md` § 6). In-process / single-node — a distributed limiter is a follow-up
 * (documented in ADR D3). `tryAcquire` is a synchronous Map mutation; on Node's
 * single-threaded event loop it is atomic per call (no Lost Update).
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
      this.windows.set(workspaceId, { start: nowMs, count: 1 });
      return true;
    }
    if (w.count < this.rpm) {
      w.count += 1;
      return true;
    }
    return false;
  }
}
