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
