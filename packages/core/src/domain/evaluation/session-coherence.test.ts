import { describe, expect, it, vi } from "vitest";

import type { TraceListItem } from "../observability/trace-list.js";
import type { JudgeClient } from "./llm-judge.js";
import {
  assembleSessionTranscript,
  COHERENCE_THRESHOLD,
  evaluateSessionCoherence,
  shapeCoherenceVerdict,
} from "./session-coherence.js";

function trace(o: Partial<TraceListItem> & { traceId: string }): TraceListItem {
  return { ...o };
}

describe("session-coherence evaluator (M131 B2)", () => {
  it("coherent_session_maps_to_coherent_verdict (fake judge)", async () => {
    const judge: JudgeClient = {
      judge: vi.fn().mockResolvedValue({ score: 0.9, label: "coherent", explanation: "stays on the auth task" }),
    };
    const traces = [
      trace({ traceId: "t1", startTimeUnixNano: "100", inputPreview: "add auth", outputPreview: "done" }),
      trace({ traceId: "t2", startTimeUnixNano: "200", inputPreview: "now tests", outputPreview: "added" }),
    ];
    const r = await evaluateSessionCoherence(judge, traces);
    expect(r.verdict).toBe("coherent");
    expect(r.score).toBe(0.9);
    expect(r.reasoning).toBe("stays on the auth task");
    // the judge saw the ordered transcript, not raw traces
    expect((judge.judge as ReturnType<typeof vi.fn>).mock.calls[0][1]).toContain("Turn 0");
  });

  it("incoherent_session_topic_switch_maps_to_incoherent_with_citation", async () => {
    const judge: JudgeClient = {
      judge: vi.fn().mockResolvedValue({ score: 0.25, label: "incoherent", explanation: "abrupt topic switch at turn 1" }),
    };
    const traces = [
      trace({ traceId: "t1", startTimeUnixNano: "100", inputPreview: "fix the bug", outputPreview: "ok" }),
      trace({ traceId: "t2", startTimeUnixNano: "200", inputPreview: "what's the weather?", outputPreview: "sunny" }),
    ];
    const r = await evaluateSessionCoherence(judge, traces);
    expect(r.verdict).toBe("incoherent");
    expect(r.score).toBeLessThan(COHERENCE_THRESHOLD);
    expect(r.reasoning).toContain("turn 1");
  });

  it("assembles_transcript_in_conversation_order (by span start asc)", () => {
    const traces = [
      trace({ traceId: "b", startTimeUnixNano: "200", inputPreview: "SECOND" }),
      trace({ traceId: "a", startTimeUnixNano: "100", inputPreview: "FIRST" }),
    ];
    const t = assembleSessionTranscript(traces);
    expect(t.indexOf("FIRST")).toBeLessThan(t.indexOf("SECOND")); // ordered, not input order
  });

  it("label_only_verdict_falls_back_to_score_mapping", () => {
    expect(shapeCoherenceVerdict({ label: "coherent" }).verdict).toBe("coherent");
    expect(shapeCoherenceVerdict({ label: "incoherent" }).verdict).toBe("incoherent");
    // borderline: exactly the threshold is coherent
    expect(shapeCoherenceVerdict({ score: COHERENCE_THRESHOLD }).verdict).toBe("coherent");
    expect(shapeCoherenceVerdict({ score: COHERENCE_THRESHOLD - 0.01 }).verdict).toBe("incoherent");
  });

  it("judge_failure_propagates (fail-closed — caller writes no verdict)", async () => {
    const judge: JudgeClient = { judge: vi.fn().mockRejectedValue(new Error("judge down")) };
    await expect(evaluateSessionCoherence(judge, [trace({ traceId: "t1", startTimeUnixNano: "1" })])).rejects.toThrow();
  });
});
