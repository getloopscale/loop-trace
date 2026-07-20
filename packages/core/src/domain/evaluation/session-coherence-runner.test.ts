import { describe, expect, it, vi } from "vitest";

import type { TraceListItem } from "../observability/trace-list.js";
import type { JudgeClient } from "./llm-judge.js";
import {
  runSessionCoherence,
  sessionVersion,
  type CachedSessionVerdict,
  type SessionCoherenceDeps,
  type SessionVerdictWrite,
} from "./session-coherence-runner.js";

function trace(o: Partial<TraceListItem> & { traceId: string }): TraceListItem {
  return { ...o };
}

/** A FRESH coherent judge per test (a shared vi.fn() would accumulate calls across tests). */
function makeJudge(): JudgeClient {
  return { judge: vi.fn().mockResolvedValue({ score: 0.9, label: "coherent", explanation: "on topic" }) };
}

/** An in-memory verdict store so the runner's cache path is exercised end-to-end. */
function makeDeps(traces: TraceListItem[] | null, judge: JudgeClient = makeJudge()): SessionCoherenceDeps & { saved: SessionVerdictWrite[] } {
  const saved: SessionVerdictWrite[] = [];
  return {
    judge,
    saved,
    getTraces: vi.fn().mockResolvedValue(traces),
    getCached: async (): Promise<CachedSessionVerdict | null> => {
      const last = saved[saved.length - 1];
      return last ? { sessionVersion: last.sessionVersion, verdict: last.verdict, score: last.score, reasoning: last.reasoning } : null;
    },
    saveVerdict: async (rec) => {
      saved.push(rec);
    },
    judgeModel: "gpt-4o-mini",
  };
}

describe("session-coherence runner + cache (M131 B3)", () => {
  it("first_run_calls_judge_and_persists_verdict", async () => {
    const deps = makeDeps([trace({ traceId: "t1", startTimeUnixNano: "100", endTimeUnixNano: "150", inputPreview: "add auth" })]);
    const r = await runSessionCoherence(deps, "S1");
    expect(r?.cached).toBe(false);
    expect(r?.verdict).toBe("coherent");
    expect(deps.judge.judge).toHaveBeenCalledTimes(1);
    expect(deps.saved).toHaveLength(1);
    expect(deps.saved[0].model).toBe("gpt-4o-mini");
    expect(deps.saved[0].sessionVersion).toHaveLength(16);
  });

  it("second_run_same_content_is_a_cache_hit_and_does_not_call_judge", async () => {
    const deps = makeDeps([trace({ traceId: "t1", startTimeUnixNano: "100", endTimeUnixNano: "150" })]);
    await runSessionCoherence(deps, "S1"); // warms the cache
    const before = (deps.judge.judge as ReturnType<typeof vi.fn>).mock.calls.length;
    const r2 = await runSessionCoherence(deps, "S1");
    expect(r2?.cached).toBe(true);
    // CRITICAL: no additional judge call — the LLM spend is skipped on unchanged content.
    expect((deps.judge.judge as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
    expect(deps.saved).toHaveLength(1); // no second write
  });

  it("adding_a_trace_changes_the_version_and_re_judges_exactly_once", async () => {
    const t1 = trace({ traceId: "t1", startTimeUnixNano: "100", endTimeUnixNano: "150" });
    const deps = makeDeps([t1]);
    await runSessionCoherence(deps, "S1");
    const v1 = deps.saved[0].sessionVersion;
    // a new trace lands → getTraces now returns two
    (deps.getTraces as ReturnType<typeof vi.fn>).mockResolvedValue([t1, trace({ traceId: "t2", startTimeUnixNano: "200", endTimeUnixNano: "250" })]);
    const r3 = await runSessionCoherence(deps, "S1");
    expect(r3?.cached).toBe(false); // version changed → not a cache hit
    expect(deps.judge.judge).toHaveBeenCalledTimes(2); // re-judged exactly once more
    expect(deps.saved[1].sessionVersion).not.toBe(v1); // new version persisted (overwrite)
  });

  it("absent_session_returns_null (route → 404), no judge call", async () => {
    const deps = makeDeps(null);
    const r = await runSessionCoherence(deps, "missing");
    expect(r).toBeNull();
    expect(deps.judge.judge).not.toHaveBeenCalled();
  });

  it("sessionVersion_is_order_independent (same traces, any input order → same hash)", () => {
    const a = trace({ traceId: "a", endTimeUnixNano: "1" });
    const b = trace({ traceId: "b", endTimeUnixNano: "2" });
    expect(sessionVersion([a, b])).toBe(sessionVersion([b, a]));
  });
});
