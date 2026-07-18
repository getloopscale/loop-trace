import { describe, it, expect } from "vitest";

import {
  evaluatorRecordSchema,
  guardRecordSchema,
  runResultResponseSchema,
  runCompareDeltasSchema,
  copilotFeedbackRecordSchema,
  replayResponseSchema,
} from "./advanced-responses.js";

/**
 * M118 (D4) — the boundary response schemas accept the EXACT wire shape (lifted from the M117 SDK
 * hand-types) and reject an extra/leaked field (`.strict()`). This pins the schema to the reviewed
 * shape so a future drift is caught at the boundary, not shipped.
 */
describe("M118 advanced response schemas", () => {
  it("evaluator_record_accepts_rule_shape_and_rejects_extra_field", () => {
    const rec = { id: "e1", createdAt: "2026-07-07T00:00:00Z", name: "has-good", target: "", enabled: true, kind: "rule", config: { predicate: "" } };
    expect(evaluatorRecordSchema.parse(rec)).toEqual(rec);
    // optional passLabel/failLabel accepted
    expect(() => evaluatorRecordSchema.parse({ ...rec, passLabel: "ok", failLabel: "no" })).not.toThrow();
    // a leaked persistence column is rejected
    expect(() => evaluatorRecordSchema.parse({ ...rec, workspace_id: "leak" })).toThrow();
  });

  it("evaluator_record_accepts_llm_judge_shape", () => {
    const rec = { id: "e2", createdAt: "2026-07-07T00:00:00Z", name: "judge", target: "", enabled: true, kind: "llm_judge", config: { prompt: "p", model: "m" } };
    expect(evaluatorRecordSchema.parse(rec)).toEqual(rec);
  });

  it("guard_record_accepts_shape_and_rejects_extra_field", () => {
    const rec = { id: "g1", createdAt: "2026-07-07T00:00:00Z", evaluatorId: "e1", operator: "lt", threshold: 0.5, enabled: true };
    expect(guardRecordSchema.parse(rec)).toEqual(rec);
    expect(() => guardRecordSchema.parse({ ...rec, workspace_id: "leak" })).toThrow();
  });

  it("run_result_accepts_shape_with_nested_errors", () => {
    const rr = { evaluator: "has-good", written: 3, skipped: 1, truncated: false, errors: [{ spanId: "s1", reason: "boom" }] };
    expect(runResultResponseSchema.parse(rr)).toEqual(rr);
  });

  it("run_compare_deltas_allow_null_metric_sides", () => {
    const d = { passCountDelta: 1, passRateDelta: 0.1, avgScoreDelta: null, totalCostDelta: 0, avgLatencyDelta: null };
    expect(runCompareDeltasSchema.parse(d)).toEqual(d);
  });

  it("copilot_feedback_record_omits_optional_spanId_question", () => {
    const rec = { id: "f1", traceId: "t1", turnId: "u1", label: "up", updatedAt: "2026-07-07T00:00:00Z" };
    expect(copilotFeedbackRecordSchema.parse(rec)).toEqual(rec);
    expect(() => copilotFeedbackRecordSchema.parse({ ...rec, label: "sideways" })).toThrow();
  });

  it("replay_response_omits_costUsd_when_absent", () => {
    const r = { output: "o", promptTokens: 1, completionTokens: 2, totalTokens: 3, latencyMs: 10, model: "m" };
    expect(replayResponseSchema.parse(r)).toEqual(r);
    expect(replayResponseSchema.parse({ ...r, costUsd: 0.001 })).toMatchObject({ costUsd: 0.001 });
  });
});
