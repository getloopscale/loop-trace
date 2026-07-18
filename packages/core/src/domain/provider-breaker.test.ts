import { describe, it, expect } from "vitest";

import { ProviderBreaker, ProviderBreakerOpenError, DEFAULT_PROVIDER_BREAKER } from "./provider-breaker.js";
import { OpenAICompatibleChat, ChatError } from "./chat.js";

/**
 * M118 (T4.1 / D2) — a hand-rolled closed/open/half-open breaker wrapping the provider call. Clock-
 * injected + env-tunable. OPEN fast-fails WITHOUT invoking the provider (stops paying CHAT_TIMEOUT×retry
 * when the provider is down, which compounds with the 500-call evaluator fan-out).
 */

/** A stub provider that fails or succeeds on demand, counting how many times it was actually invoked. */
function stubProvider() {
  const s = { calls: 0, mode: "fail" as "fail" | "ok" };
  return {
    get calls() { return s.calls; },
    setMode(m: "fail" | "ok") { s.mode = m; },
    fn: async (): Promise<string> => {
      s.calls += 1;
      if (s.mode === "fail") throw new Error("provider 503");
      return "ok";
    },
  };
}

const CFG = { failureThreshold: 3, cooldownMs: 10_000 };

describe("M118 ProviderBreaker", () => {
  it("test_breaker_opens_after_threshold_and_fast_fails_503", async () => {
    const now = 1_000_000;
    const breaker = new ProviderBreaker(CFG, () => now);
    const p = stubProvider();
    // N consecutive failures trip the breaker.
    for (let i = 0; i < CFG.failureThreshold; i += 1) {
      await expect(breaker.run(p.fn)).rejects.toThrow(); // each real call fails
    }
    const callsAtOpen = p.calls;
    expect(callsAtOpen).toBe(CFG.failureThreshold); // all reached the provider so far
    // Now OPEN: the next call fast-fails WITHOUT invoking the provider.
    await expect(breaker.run(p.fn)).rejects.toBeInstanceOf(ProviderBreakerOpenError);
    expect(p.calls).toBe(callsAtOpen); // provider NOT called while OPEN
  });

  it("test_breaker_half_open_probe_after_cooldown", async () => {
    let now = 2_000_000;
    const breaker = new ProviderBreaker(CFG, () => now);
    const p = stubProvider();
    for (let i = 0; i < CFG.failureThreshold; i += 1) await expect(breaker.run(p.fn)).rejects.toThrow();
    const opened = p.calls;
    // Still within cooldown → fast-fail, no probe.
    now += CFG.cooldownMs - 1;
    await expect(breaker.run(p.fn)).rejects.toBeInstanceOf(ProviderBreakerOpenError);
    expect(p.calls).toBe(opened);
    // After cooldown → exactly ONE probe is admitted (HALF-OPEN). It still fails here.
    now += 2;
    await expect(breaker.run(p.fn)).rejects.toThrow();
    expect(p.calls).toBe(opened + 1); // exactly one probe reached the provider
    // A failed probe re-opens: the next call fast-fails again.
    await expect(breaker.run(p.fn)).rejects.toBeInstanceOf(ProviderBreakerOpenError);
    expect(p.calls).toBe(opened + 1);
  });

  it("test_breaker_closes_on_successful_probe", async () => {
    let now = 3_000_000;
    const breaker = new ProviderBreaker(CFG, () => now);
    const p = stubProvider();
    for (let i = 0; i < CFG.failureThreshold; i += 1) await expect(breaker.run(p.fn)).rejects.toThrow();
    now += CFG.cooldownMs + 1;
    p.setMode("ok");
    // The HALF-OPEN probe succeeds → CLOSED.
    await expect(breaker.run(p.fn)).resolves.toBe("ok");
    // CLOSED again: subsequent calls reach the provider normally.
    const after = p.calls;
    await expect(breaker.run(p.fn)).resolves.toBe("ok");
    expect(p.calls).toBe(after + 1);
  });

  it("test_breaker_opens_exactly_once_under_concurrent_failures", async () => {
    let now = 4_000_000;
    const breaker = new ProviderBreaker(CFG, () => now);
    const p = stubProvider();
    // Fire MANY concurrent failing calls at once (Promise.all). The transition to OPEN must happen
    // exactly once (the open-timestamp set once), and once OPEN the remaining calls fast-fail without
    // invoking the provider — so the provider is invoked at most `failureThreshold` times, never more.
    const N = 20;
    const results = await Promise.allSettled(Array.from({ length: N }, () => breaker.run(p.fn)));
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    // Atomic-counter invariant: the provider saw at most the threshold count (excess calls fast-failed).
    expect(p.calls).toBeLessThanOrEqual(CFG.failureThreshold);
    // The breaker records exactly one OPEN transition.
    expect(breaker.openTransitions).toBe(1);
    // Under concurrent probes after cooldown, at most ONE probe is admitted.
    now += CFG.cooldownMs + 1;
    const probeCallsBefore = p.calls;
    await Promise.allSettled(Array.from({ length: N }, () => breaker.run(p.fn)));
    expect(p.calls - probeCallsBefore).toBeLessThanOrEqual(1);
  });

  it("default_config_is_present_and_sane", () => {
    expect(DEFAULT_PROVIDER_BREAKER.failureThreshold).toBeGreaterThan(0);
    expect(DEFAULT_PROVIDER_BREAKER.cooldownMs).toBeGreaterThan(0);
  });
});

describe("M118 breaker wired into OpenAICompatibleChat (caller wiring)", () => {
  it("client_fast_fails_open_after_sustained_provider_5xx_without_calling_fetch", async () => {
    // Deterministic + fast: 1 attempt per ask (no retry sleep), a low breaker threshold. The client
    // reads env at construction (parseProviderRetry/parseProviderBreaker).
    const saved = { ...process.env };
    process.env["THEOLENS_PROVIDER_MAX_ATTEMPTS"] = "1";
    process.env["THEOLENS_PROVIDER_BREAKER_THRESHOLD"] = "3";
    process.env["THEOLENS_PROVIDER_BREAKER_COOLDOWN_MS"] = "10000";
    try {
      let fetchCalls = 0;
      const failing: typeof fetch = async () => {
        fetchCalls += 1;
        return new Response("boom", { status: 503 });
      };
      const client = new OpenAICompatibleChat({ baseUrl: "https://x", apiKey: "k", model: "m" }, failing);
      // 3 consecutive failing asks trip the breaker (1 fetch each, all 503 → outage).
      for (let i = 0; i < 3; i += 1) {
        await expect(client.ask([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(ChatError);
      }
      const callsBefore = fetchCalls;
      expect(callsBefore).toBe(3);
      // OPEN → the next ask fast-fails WITHOUT touching fetch.
      await expect(client.ask([{ role: "user", content: "hi" }])).rejects.toBeInstanceOf(ProviderBreakerOpenError);
      expect(fetchCalls).toBe(callsBefore); // no provider call while OPEN
    } finally {
      process.env = saved;
    }
  });
});
