/**
 * M131 B4 — Session Coherence run + read routes. `POST /v1/sessions/:id/coherence` runs the
 * session-level LLM-as-judge (rate-limited, mirroring the M118 evaluator-run billable guard) and
 * persists the verdict; `GET` returns the cached verdict (null when never judged → badge "pending").
 * DIP: the judge + verdict store are injected (built at the composition root with the real judge/db),
 * so a fake judge + in-memory store drive the route test. Fail-closed: no judge → 503; judge error →
 * 502 with NO verdict written (never a fabricated verdict).
 */
import type { Hono } from "hono";

import {
  type SessionRepository,
  type JudgeClient,
  type RateLimiter,
  type CachedSessionVerdict,
  type SessionVerdictWrite,
  type SessionCoherenceDeps,
  runSessionCoherence,
  sessionCoherenceResponseSchema,
  SESSION_COHERENCE_NAME,
  apiError,
} from "@usetheo/lens-core";

import { getPrincipal, requireScopeOnPrincipal } from "../auth/middleware.js";

export interface SessionCoherenceApiDeps {
  /** the pinned judge, or null when unconfigured (route → 503, fail-closed). */
  judge: JudgeClient | null;
  getCached: (workspaceId: string, sessionId: string, name: string) => Promise<CachedSessionVerdict | null>;
  saveVerdict: (workspaceId: string, rec: SessionVerdictWrite) => Promise<void>;
  /** the judge model name recorded on the verdict (for the benchmark). */
  judgeModel?: string;
  /** per-workspace billable-run limiter (the LLM-spend abuse guard). */
  limiter?: RateLimiter;
  /** injected clock for the limiter window (deterministic tests). */
  now?: () => number;
}

export function registerSessionCoherenceRoutes(
  app: Hono,
  repo: SessionRepository,
  deps: SessionCoherenceApiDeps,
): void {
  // Read the cached verdict (null when never judged). Cheap — no judge call.
  app.get("/v1/sessions/:sessionId/coherence", requireScopeOnPrincipal("observability:read"), async (c) => {
    const ws = getPrincipal(c).workspaceId;
    const v = await deps.getCached(ws, c.req.param("sessionId"), SESSION_COHERENCE_NAME);
    const body = v
      ? {
          verdict: v.verdict === "coherent" ? ("coherent" as const) : ("incoherent" as const),
          ...(v.score != null ? { score: v.score } : {}),
          ...(v.reasoning != null ? { reasoning: v.reasoning } : {}),
          cached: true,
        }
      : { verdict: null };
    return c.json(sessionCoherenceResponseSchema.parse(body), 200);
  });

  // Run (or reuse cached) the coherence judge. Billable → rate-limited; write scope.
  app.post("/v1/sessions/:sessionId/coherence", requireScopeOnPrincipal("observability:write"), async (c) => {
    const ws = getPrincipal(c).workspaceId;

    if (deps.limiter) {
      const nowMs = (deps.now ?? Date.now)();
      if (!deps.limiter.tryAcquire(ws, nowMs)) {
        c.header("Retry-After", String(deps.limiter.retryAfterSeconds(ws, nowMs)));
        return c.json(apiError("RATE_LIMITED", "coherence-run rate limit exceeded"), 429);
      }
    }
    if (deps.judge === null) {
      return c.json(apiError("JUDGE_NOT_CONFIGURED", "session-coherence judge is not configured"), 503);
    }

    const sessionId = c.req.param("sessionId");
    const runnerDeps: SessionCoherenceDeps = {
      judge: deps.judge,
      getTraces: async (sid) => {
        const detail = await repo.getSessionDetail(sid, ws);
        return detail ? detail.traces : null;
      },
      getCached: (sid, name) => deps.getCached(ws, sid, name),
      saveVerdict: (rec) => deps.saveVerdict(ws, rec),
      ...(deps.judgeModel != null ? { judgeModel: deps.judgeModel } : {}),
    };

    try {
      const r = await runSessionCoherence(runnerDeps, sessionId);
      if (r === null) return c.json(apiError("NOT_FOUND", "not found"), 404);
      const body = {
        verdict: r.verdict,
        score: r.score,
        ...(r.reasoning != null ? { reasoning: r.reasoning } : {}),
        cached: r.cached,
      };
      return c.json(sessionCoherenceResponseSchema.parse(body), 200);
    } catch {
      // JudgeError (timeout / 5xx / malformed) → fail-closed: NO verdict written, never fabricated.
      return c.json(apiError("JUDGE_FAILED", "coherence evaluation failed"), 502);
    }
  });
}
