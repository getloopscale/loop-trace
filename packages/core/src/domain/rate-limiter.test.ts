import { describe, it, expect } from "vitest";
import { RateLimiter } from "./rate-limiter.js";

describe("M33 RateLimiter (T2.2)", () => {
  it("test_allows_rpm_then_blocks", () => {
    const rl = new RateLimiter(2, 60_000);
    expect(rl.tryAcquire("ws", 0)).toBe(true);
    expect(rl.tryAcquire("ws", 10)).toBe(true);
    expect(rl.tryAcquire("ws", 20)).toBe(false); // rpm+1 within window
  });
  it("test_window_resets_after_windowMs", () => {
    const rl = new RateLimiter(1, 60_000);
    expect(rl.tryAcquire("ws", 0)).toBe(true);
    expect(rl.tryAcquire("ws", 59_999)).toBe(false);
    expect(rl.tryAcquire("ws", 60_000)).toBe(true); // reset at >= windowMs
  });
  it("test_per_workspace_independent", () => {
    const rl = new RateLimiter(1, 60_000);
    expect(rl.tryAcquire("a", 0)).toBe(true);
    expect(rl.tryAcquire("b", 0)).toBe(true); // b independent of a
    expect(rl.tryAcquire("a", 0)).toBe(false);
  });
  it("test_concurrent_acquire_grants_exactly_rpm", async () => {
    // EC-7: K concurrent acquires at one instant grant exactly rpm (atomic counter).
    const rl = new RateLimiter(3, 60_000);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => Promise.resolve(rl.tryAcquire("ws", 0))),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
  });
});
