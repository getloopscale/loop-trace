import type { TraceTreeNode } from "../api/types.js";

/** One span's waterfall geometry, relative to the whole trace's time span. */
export interface TimelineEntry {
  spanId: string;
  offsetMs: number;
  durationMs: number;
  depth: number;
  /** Bar left edge as a percent of the trace span [0,100]. */
  leftPct: number;
  /** Bar width as a percent [floor,100], so a near-zero span stays visible. */
  widthPct: number;
}

/** Floor so a near-zero-duration span still renders a clickable bar. */
const MIN_WIDTH_PCT = 1;

/** Nanos as BigInt; a malformed value is treated as absent (tolerated). */
function nanos(value: string | undefined): bigint | undefined {
  if (value == null) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** BigInt → percent with 2-decimal precision (no float drift on the division). */
function pct(part: bigint, total: bigint): number {
  if (total <= 0n) return 0;
  const p = part < 0n ? 0n : part;
  return Number((p * 10_000n) / total) / 100;
}

/**
 * Compute each span's waterfall geometry relative to the WHOLE trace's
 * [minStart, maxEnd] (the aggregate min start / max end over ALL spans, not the
 * root's own times — a re-rooted orphan or cross-process skew can start before
 * the root or end after it, EC-1). BigInt math (nanos exceed 2^53, risk #1);
 * clock-skew (end<start) clamps duration to 0; a malformed nanos is tolerated; a
 * zero total span never yields NaN. Every bar is clamped to [0,100]%.
 */
export function buildTimeline(root: TraceTreeNode): Map<string, TimelineEntry> {
  const all: { node: TraceTreeNode; depth: number }[] = [];
  const walk = (n: TraceTreeNode, depth: number): void => {
    all.push({ node: n, depth });
    for (const c of n.children) walk(c, depth + 1);
  };
  walk(root, 0);

  let minStart: bigint | undefined;
  let maxEnd: bigint | undefined;
  for (const { node } of all) {
    const s = nanos(node.startTimeUnixNano);
    const e = nanos(node.endTimeUnixNano);
    if (s != null && (minStart == null || s < minStart)) minStart = s;
    // End candidate: a skewed end<start must not pull maxEnd below the start.
    const endCand = e != null && (s == null || e >= s) ? e : s;
    if (endCand != null && (maxEnd == null || endCand > maxEnd)) maxEnd = endCand;
  }

  const totalNs =
    minStart != null && maxEnd != null && maxEnd > minStart
      ? maxEnd - minStart
      : 0n;

  const out = new Map<string, TimelineEntry>();
  for (const { node, depth } of all) {
    const s = nanos(node.startTimeUnixNano);
    const e = nanos(node.endTimeUnixNano);
    const offNs = s != null && minStart != null && s > minStart ? s - minStart : 0n;
    const durNs = s != null && e != null && e > s ? e - s : 0n;

    let leftPct: number;
    let widthPct: number;
    if (totalNs <= 0n) {
      leftPct = 0;
      widthPct = 100;
    } else {
      leftPct = clamp(pct(offNs, totalNs), 0, 100);
      widthPct = Math.max(MIN_WIDTH_PCT, pct(durNs, totalNs));
      if (leftPct + widthPct > 100) widthPct = Math.max(MIN_WIDTH_PCT, 100 - leftPct);
    }

    out.set(node.spanId, {
      spanId: node.spanId,
      offsetMs: Number(offNs / 1_000_000n),
      durationMs: Number(durNs / 1_000_000n),
      depth,
      leftPct,
      widthPct,
    });
  }
  return out;
}
