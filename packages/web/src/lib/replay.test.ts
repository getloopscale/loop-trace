import { describe, it, expect } from "vitest";
import { buildReplaySteps, initialStepIndex } from "./replay.js";
import type { SpanNodeData, TraceTreeNode } from "../api/types.js";

function node(
  spanId: string,
  start: string,
  children: TraceTreeNode[] = [],
): TraceTreeNode {
  return {
    spanId,
    traceId: "t",
    name: spanId,
    startTimeUnixNano: start,
    endTimeUnixNano: start,
    children,
  };
}

describe("buildReplaySteps", () => {
  it("build_replay_steps_orders_preorder_children_by_start_time", () => {
    const tree = node("root", "0", [
      node("late", "300"),
      node("early", "100", [node("grandchild", "150")]),
    ]);
    expect(buildReplaySteps(tree).map((s) => s.spanId)).toEqual([
      "root",
      "early",
      "grandchild",
      "late",
    ]);
  });

  it("build_replay_steps_is_deterministic_under_concurrent_spans", () => {
    // Two parallel tool calls with the SAME start time → ordered by spanId, stable.
    const tree = node("root", "0", [node("b-tool", "100"), node("a-tool", "100")]);
    const first = buildReplaySteps(tree).map((s) => s.spanId);
    const second = buildReplaySteps(tree).map((s) => s.spanId);
    expect(first).toEqual(["root", "a-tool", "b-tool"]); // equal start → spanId order
    expect(second).toEqual(first); // idempotent / deterministic
  });

  it("build_replay_steps_single_node_and_tolerates_malformed_start", () => {
    expect(buildReplaySteps(node("only", "0")).map((s) => s.spanId)).toEqual([
      "only",
    ]);
    // a malformed start time does not throw and still yields every present span
    const tree = node("root", "0", [node("bad", "not-a-number")]);
    expect(buildReplaySteps(tree).map((s) => s.spanId)).toEqual(["root", "bad"]);
  });

  it("build_replay_steps_emits_every_span_exactly_once_gap_free", () => {
    // A re-rooted/gappy session (orphan attached at root by getTraceTree) must still
    // yield every present span exactly once — no drop, no duplicate (risk #2).
    const tree = node("root", "0", [
      node("a", "100", [node("a1", "150")]),
      node("orphan", "120"), // would-be-nested span re-rooted under root
      node("b", "110"),
    ]);
    const ids = buildReplaySteps(tree).map((s) => s.spanId);
    expect(ids.length).toBe(5);
    expect(new Set(ids).size).toBe(5); // no duplicates
    expect([...ids].sort()).toEqual(["a", "a1", "b", "orphan", "root"]);
  });
});

describe("initialStepIndex (M35)", () => {
  const step = (spanId: string, io?: Partial<SpanNodeData>): SpanNodeData => ({
    spanId,
    traceId: "t",
    name: spanId,
    startTimeUnixNano: "0",
    endTimeUnixNano: "0",
    ...io,
  });

  it("test_initial_step_index_picks_first_span_with_io", () => {
    // Claude shape: root llm_request (no I/O) then a tool with input+output.
    const steps = [
      step("llm"),
      step("tool", { inputValue: "echo x", outputValue: "x\n" }),
      step("tool2", { inputValue: "ls" }),
    ];
    expect(initialStepIndex(steps)).toBe(1);
  });

  it("test_initial_step_index_zero_when_root_has_io", () => {
    // Non-Claude shape (demo/langfuse): the root carries the I/O → no regression.
    const steps = [step("root", { inputValue: "q", outputValue: "a" }), step("child")];
    expect(initialStepIndex(steps)).toBe(0);
  });

  it("test_initial_step_index_zero_when_none_have_io", () => {
    expect(initialStepIndex([step("a"), step("b"), step("c")])).toBe(0);
  });

  it("test_initial_step_index_matches_output_only_span", () => {
    // output without input still counts as I/O-bearing.
    expect(initialStepIndex([step("a"), step("b", { outputValue: "r" })])).toBe(1);
  });
});
