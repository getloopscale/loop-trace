import type { SpanNodeData, TraceTreeNode } from "../api/types.js";

/** Nanos as BigInt (no 2^53 loss); a malformed value sorts as 0 (gap-tolerant). */
function startNanos(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * Deterministic sibling order (M4 ADR D1): earliest start first; ties (concurrent /
 * parallel tool calls) broken by `spanId` lexicographic so the order is STABLE
 * across fetches — never wall-clock-ambiguous (risk #1).
 */
function compareSpans(a: TraceTreeNode, b: TraceTreeNode): number {
  const sa = startNanos(a.startTimeUnixNano);
  const sb = startNanos(b.startTimeUnixNano);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return a.spanId < b.spanId ? -1 : a.spanId > b.spanId ? 1 : 0;
}

/**
 * Flatten a trace tree into the deterministic replay step sequence: DFS preorder
 * (parent before its sub-steps — user → tool → output), children sorted by
 * {@link compareSpans}. Pure + idempotent; every present span appears exactly once
 * (gap-tolerant — orphans are already re-rooted by `getTraceTree`).
 */
export function buildReplaySteps(root: TraceTreeNode): SpanNodeData[] {
  const steps: SpanNodeData[] = [];
  const walk = (node: TraceTreeNode): void => {
    steps.push(node);
    for (const child of [...node.children].sort(compareSpans)) walk(child);
  };
  walk(root);
  return steps;
}

/**
 * The replay index the trace detail should OPEN on (M35): the first step that has
 * input/output text, else 0. A Claude Code trace's root is `claude_code.llm_request`
 * (no I/O — the LLM body is not emitted), but its `claude_code.tool` children carry
 * the real command + result; opening on the first I/O-bearing step surfaces that
 * content without the user hunting for it. A trace whose root DOES have I/O (demo /
 * langfuse) returns 0 — no regression. Pure; the replay ORDER is unchanged.
 */
export function initialStepIndex(steps: readonly SpanNodeData[]): number {
  const i = steps.findIndex(
    (s) => s.inputValue != null || s.outputValue != null,
  );
  return i >= 0 ? i : 0;
}
