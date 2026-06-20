import { describe, it, expect } from "vitest";
import { buildReplaySteps } from "./replay.js";
import type { TraceTreeNode } from "../api/types.js";

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

  it("build_replay_steps_handles_single_node_and_gaps", () => {
    expect(buildReplaySteps(node("only", "0")).map((s) => s.spanId)).toEqual([
      "only",
    ]);
    // a malformed start time does not throw and still yields every present span
    const tree = node("root", "0", [node("bad", "not-a-number")]);
    expect(buildReplaySteps(tree).map((s) => s.spanId)).toEqual(["root", "bad"]);
  });
});
