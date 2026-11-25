import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { JudgeClient, TraceListItem, SessionVerdictWrite, RateLimiter } from "@looptrace/core";

import { registerSessionCoherenceRoutes, type SessionCoherenceApiDeps } from "./session-coherence-routes.js";

/** Build the route deps with an in-memory verdict store + an injected trace source (null = absent). */
function makeDeps(
  judge: JudgeClient | null,
  traces: TraceListItem[] | null,
): SessionCoherenceApiDeps & { store: Map<string, SessionVerdictWrite> } {
  const store = new Map<string, SessionVerdictWrite>();
  return {
    judge,
    store,
    judgeModel: "gpt-4o-mini",
    getTraces: async () => traces,
    getCached: async (ws, sid, name) => {
      const r = store.get(`${ws}:${sid}:${name}`);
      return r ? { sessionVersion: r.sessionVersion, verdict: r.verdict, score: r.score, reasoning: r.reasoning } : null;
    },
    saveVerdict: async (ws, rec) => {
      store.set(`${ws}:${rec.sessionId}:${rec.name}`, rec);
    },
  };
}

describe("session-coherence routes (M131 B4)", () => {
  it("POST_runs_the_judge_and_returns_the_verdict", async () => {
    const judge: JudgeClient = { judge: vi.fn().mockResolvedValue({ score: 0.9, label: "coherent", explanation: "on topic" }) };
    const deps = makeDeps(judge, [{ traceId: "t1", startTimeUnixNano: "1", inputPreview: "hi" }]);
    const app = new Hono();
    registerSessionCoherenceRoutes(app, deps);
    const res = await app.request("/v1/sessions/S1/coherence", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verdict: string; cached: boolean };
    expect(body.verdict).toBe("coherent");
    expect(body.cached).toBe(false);
    expect(deps.store.size).toBe(1); // verdict persisted
  });

  it("POST_absent_session_is_404", async () => {
    const app = new Hono();
    registerSessionCoherenceRoutes(app, makeDeps({ judge: vi.fn() }, null));
    const res = await app.request("/v1/sessions/missing/coherence", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST_no_judge_configured_is_503", async () => {
    const app = new Hono();
    registerSessionCoherenceRoutes(app, makeDeps(null, [{ traceId: "t1" }]));
    const res = await app.request("/v1/sessions/S1/coherence", { method: "POST" });
    expect(res.status).toBe(503);
  });

  it("POST_rate_limited_is_429_with_retry_after (review M3 — billable-spend guard)", async () => {
    const judge: JudgeClient = { judge: vi.fn() };
    const deps = makeDeps(judge, [{ traceId: "t1", startTimeUnixNano: "1" }]);
    // a limiter that always denies → the run is shed BEFORE any judge call.
    deps.limiter = { tryAcquire: () => false, retryAfterSeconds: () => 30 } as unknown as RateLimiter;
    const app = new Hono();
    registerSessionCoherenceRoutes(app, deps);
    const res = await app.request("/v1/sessions/S1/coherence", { method: "POST" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(judge.judge).not.toHaveBeenCalled(); // no LLM spend when rate-limited
  });

  it("POST_judge_failure_is_502_and_writes_no_verdict (fail-closed)", async () => {
    const judge: JudgeClient = { judge: vi.fn().mockRejectedValue(new Error("judge down")) };
    const deps = makeDeps(judge, [{ traceId: "t1", startTimeUnixNano: "1" }]);
    const app = new Hono();
    registerSessionCoherenceRoutes(app, deps);
    const res = await app.request("/v1/sessions/S1/coherence", { method: "POST" });
    expect(res.status).toBe(502);
    expect(deps.store.size).toBe(0); // NEVER a fabricated verdict
  });

  it("GET_returns_null_when_never_judged_then_the_cached_verdict_after_a_run", async () => {
    const judge: JudgeClient = { judge: vi.fn().mockResolvedValue({ score: 0.2, label: "incoherent", explanation: "topic switch at turn 1" }) };
    const deps = makeDeps(judge, [{ traceId: "t1", startTimeUnixNano: "1" }]);
    const app = new Hono();
    registerSessionCoherenceRoutes(app, deps);

    const before = await app.request("/v1/sessions/S1/coherence");
    expect(((await before.json()) as { verdict: unknown }).verdict).toBeNull();

    await app.request("/v1/sessions/S1/coherence", { method: "POST" });

    const after = await app.request("/v1/sessions/S1/coherence");
    const body = (await after.json()) as { verdict: string; reasoning: string; cached: boolean };
    expect(body.verdict).toBe("incoherent");
    expect(body.reasoning).toContain("turn 1");
    expect(body.cached).toBe(true);
  });
});
