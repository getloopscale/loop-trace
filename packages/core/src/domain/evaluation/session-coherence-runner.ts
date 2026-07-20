/**
 * M131 B3 — the Session Coherence runner with content-version caching. Pure orchestrator (DIP): it
 * takes the judge + injected read/write/get-traces functions, so it unit-tests with fakes and the
 * API layer wires the real Drizzle functions. The cache is keyed by `sessionVersion` (a content
 * hash of the ordered member traces) so a re-run SKIPS the judge (no LLM spend) when the session is
 * unchanged, and re-judges exactly once when a new trace lands (M131 ADR-2).
 */
import { createHash } from "node:crypto";

import type { TraceListItem } from "../observability/trace-list.js";
import type { JudgeClient } from "./llm-judge.js";
import {
  evaluateSessionCoherence,
  SESSION_COHERENCE_NAME,
  type SessionCoherenceVerdict,
} from "./session-coherence.js";

/** A stored verdict as the runner needs to read it back for the cache check. */
export interface CachedSessionVerdict {
  sessionVersion: string;
  verdict: string;
  score: number | null;
  reasoning: string | null;
}

/** The record the runner writes (mirrors the repository record, name pinned by the runner). */
export interface SessionVerdictWrite {
  sessionId: string;
  name: string;
  verdict: string;
  score: number | null;
  reasoning: string | null;
  model: string | null;
  sessionVersion: string;
}

export interface SessionCoherenceDeps {
  judge: JudgeClient;
  /** the session's ordered member traces, or null when the session does not exist. */
  getTraces: (sessionId: string) => Promise<TraceListItem[] | null>;
  getCached: (sessionId: string, name: string) => Promise<CachedSessionVerdict | null>;
  saveVerdict: (rec: SessionVerdictWrite) => Promise<void>;
  /** the pinned judge model, recorded on the verdict for the benchmark. */
  judgeModel?: string;
}

export interface SessionCoherenceResult extends SessionCoherenceVerdict {
  /** true when returned from cache (judge NOT called). */
  cached: boolean;
}

/** Content hash of the session: sorted (traceId:endTime) — changes iff a trace is added/re-ingested. */
export function sessionVersion(traces: TraceListItem[]): string {
  const sig = traces
    .map((t) => `${t.traceId}:${t.endTimeUnixNano ?? t.startTimeUnixNano ?? ""}`)
    .sort()
    .join("|");
  return createHash("sha256").update(sig).digest("hex").slice(0, 16);
}

/**
 * Run (or reuse a cached) Session Coherence verdict for a session. Returns null when the session
 * does not exist (route → 404). Throws `JudgeError` (fail-closed) when the judge fails — NO verdict
 * is written, so the badge stays "pending" rather than showing a fabricated verdict.
 */
export async function runSessionCoherence(
  deps: SessionCoherenceDeps,
  sessionId: string,
): Promise<SessionCoherenceResult | null> {
  const traces = await deps.getTraces(sessionId);
  if (traces == null) return null;

  const version = sessionVersion(traces);
  const cached = await deps.getCached(sessionId, SESSION_COHERENCE_NAME);
  if (cached != null && cached.sessionVersion === version) {
    return {
      verdict: cached.verdict === "coherent" ? "coherent" : "incoherent",
      score: cached.score ?? 0,
      ...(cached.reasoning != null ? { reasoning: cached.reasoning } : {}),
      cached: true,
    };
  }

  const v = await evaluateSessionCoherence(deps.judge, traces);
  await deps.saveVerdict({
    sessionId,
    name: SESSION_COHERENCE_NAME,
    verdict: v.verdict,
    score: v.score,
    reasoning: v.reasoning ?? null,
    model: deps.judgeModel ?? null,
    sessionVersion: version,
  });
  return { ...v, cached: false };
}
