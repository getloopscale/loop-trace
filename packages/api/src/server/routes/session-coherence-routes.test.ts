import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type {
  SessionRepository,
  JudgeClient,
  SessionVerdictWrite,
} from "@usetheo/lens-core";

import { registerSessionCoherenceRoutes, type SessionCoherenceApiDeps } from "./session-coherence-routes.js";

type TraceList = Array<{ traceId: string; startTimeUnixNano?: string; endTimeUnixNano?: string; inputPreview?: string; outputPreview?: string }>;

function makeRepo(traces: TraceList | null): SessionRepository {
  return {
    listSessions: async () => ({ sessions: [], total: 0, limit: 0, offset: 0 }),
    getSessionDetail: async (sessionId) =>
      traces
        ? {
            sessionId,
            firstSeenAt: "",
            lastSeenAt: "",
            traceCount: traces.length,
            costUsd: 0,
            totalTokens: 0,
            errorRate: 0,
            latencyP50Ms: 0,
            latencyP95Ms: 0,
            traces,
          }
        : null,
  };
}

function makeDeps(judge: JudgeClient | null): SessionCoherenceApiDeps & { store: Map<string, SessionVerdictWrite> } {
  const store = new Map<string, SessionVerdictWrite>();
  return {
    judge,
    store,
    judgeModel: "gpt-4o-mini",
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
    const deps = makeDeps(judge);
    const app = new Hono();
    registerSessionCoherenceRoutes(app, makeRepo([{ traceId: "t1", startTimeUnixNano: "1", inputPreview: "hi" }]), deps);
    const res = await app.request("/v1/sessions/S1/coherence", { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verdict: string; cached: boolean };
    expect(body.verdict).toBe("coherent");
    expect(body.cached).toBe(false);
    expect(deps.store.size).toBe(1); // verdict persisted
  });

  it("POST_absent_session_is_404", async () => {
    const app = new Hono();
    registerSessionCoherenceRoutes(app, makeRepo(null), makeDeps({ judge: vi.fn() }));
    const res = await app.request("/v1/sessions/missing/coherence", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST_no_judge_configured_is_503", async () => {
    const app = new Hono();
    registerSessionCoherenceRoutes(app, makeRepo([{ traceId: "t1" }]), makeDeps(null));
    const res = await app.request("/v1/sessions/S1/coherence", { method: "POST" });
    expect(res.status).toBe(503);
  });

  it("POST_judge_failure_is_502_and_writes_no_verdict (fail-closed)", async () => {
    const judge: JudgeClient = { judge: vi.fn().mockRejectedValue(new Error("judge down")) };
    const deps = makeDeps(judge);
    const app = new Hono();
    registerSessionCoherenceRoutes(app, makeRepo([{ traceId: "t1", startTimeUnixNano: "1" }]), deps);
    const res = await app.request("/v1/sessions/S1/coherence", { method: "POST" });
    expect(res.status).toBe(502);
    expect(deps.store.size).toBe(0); // NEVER a fabricated verdict
  });

  it("GET_returns_null_when_never_judged_then_the_cached_verdict_after_a_run", async () => {
    const judge: JudgeClient = { judge: vi.fn().mockResolvedValue({ score: 0.2, label: "incoherent", explanation: "topic switch at turn 1" }) };
    const deps = makeDeps(judge);
    const app = new Hono();
    registerSessionCoherenceRoutes(app, makeRepo([{ traceId: "t1", startTimeUnixNano: "1" }]), deps);

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
