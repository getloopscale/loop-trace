import { describe, it, expect } from "vitest";
import { buildTimeline } from "./timeline.js";
import type { TraceTreeNode } from "../api/types.js";

function node(
  spanId: string,
  start: string,
  end: string,
  children: TraceTreeNode[] = [],
): TraceTreeNode {
  return {
    spanId,
    traceId: "t1",
    name: spanId,
    startTimeUnixNano: start,
    endTimeUnixNano: end,
    children,
  };
}

const MS = 1_000_000; // ns per ms
const base = 1_700_000_000_000_000_000n;
const at = (ms: number) => String(base + BigInt(ms * MS));

describe("buildTimeline (M10)", () => {
  it("test_build_timeline_proportional_offsets_and_widths", () => {
    // root [0,1000ms]; child [200,400ms]
    const root = node("r", at(0), at(1000), [node("c", at(200), at(400))]);
    const tl = buildTimeline(root);
    expect(tl.get("r")).toMatchObject({ offsetMs: 0, durationMs: 1000, leftPct: 0 });
    const c = tl.get("c")!;
    expect(c.offsetMs).toBe(200);
    expect(c.durationMs).toBe(200);
    expect(c.leftPct).toBeCloseTo(20, 1);
    expect(c.widthPct).toBeCloseTo(20, 1);
    expect(c.depth).toBe(1);
  });

  it("test_build_timeline_bigint_nanos_no_precision_loss", () => {
    // nanos far beyond 2^53; offset must be exact (no float drift).
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    const root: TraceTreeNode = {
      ...node("r", String(big), String(big + BigInt(1000 * MS))),
      children: [node("c", String(big + BigInt(500 * MS)), String(big + BigInt(600 * MS)))],
    };
    const c = buildTimeline(root).get("c")!;
    expect(c.offsetMs).toBe(500); // exact BigInt subtraction
    expect(c.durationMs).toBe(100);
  });

  it("test_build_timeline_sub_ms_offset_survives_bigint_above_2pow53", () => {
    // A 1-NANOSECOND offset on top of a base > 2^53: a naive `Number(start)`
    // implementation would round the low bits away and lose it; BigInt keeps it.
    // We assert via percentage (offsetMs truncates sub-ms): a 1ns offset of a
    // 2ns-total trace is 50% — float coercion of these nanos would drift.
    const big = 9_007_199_254_740_993n; // 2^53 + 1
    const root: TraceTreeNode = {
      ...node("r", String(big), String(big + 2n)),
      children: [node("c", String(big + 1n), String(big + 2n))],
    };
    const c = buildTimeline(root).get("c")!;
    expect(c.leftPct).toBeCloseTo(50, 1); // 1ns of a 2ns span — exact only via BigInt
  });

  it("test_build_timeline_clamps_skew_and_tolerates_malformed", () => {
    const root = node("r", at(0), at(1000), [
      node("skew", at(800), at(200)), // end < start
      { ...node("bad", "not-a-number", "also-bad"), children: [] },
    ]);
    const tl = buildTimeline(root);
    expect(tl.get("skew")!.durationMs).toBe(0); // clamped
    expect(() => buildTimeline(root)).not.toThrow();
    expect(tl.get("bad")).toBeDefined(); // tolerated, still placed
  });

  it("test_build_timeline_zero_total_span_no_nan", () => {
    const root = node("r", at(100), at(100), [node("c", at(100), at(100))]);
    const c = buildTimeline(root).get("c")!;
    expect(Number.isNaN(c.leftPct)).toBe(false);
    expect(Number.isNaN(c.widthPct)).toBe(false);
    // Pins the documented zero-total behavior (offset 0, full width), not just non-NaN.
    expect(c.leftPct).toBe(0);
    expect(c.widthPct).toBe(100);
  });

  it("test_build_timeline_min_width_floor", () => {
    const root = node("r", at(0), at(1000), [node("tiny", at(500), at(500))]);
    expect(buildTimeline(root).get("tiny")!.widthPct).toBeGreaterThanOrEqual(1);
  });

  it("test_build_timeline_child_before_root_clamps_to_zero", () => {
    // child starts BEFORE the root (skew / re-rooted orphan); total span = [0,1000]
    const root = node("r", at(500), at(1000), [node("early", at(0), at(300))]);
    const tl = buildTimeline(root);
    const e = tl.get("early")!;
    expect(e.leftPct).toBe(0); // the early child is the aggregate min → offset 0
    expect(e.leftPct + e.widthPct).toBeLessThanOrEqual(100);
    // Proves offsets are relative to the AGGREGATE min (not the root's own start):
    // the root at 500ms of a [0,1000] span sits at ~50%, not 0.
    expect(tl.get("r")!.leftPct).toBeCloseTo(50, 0);
  });

  it("test_build_timeline_span_without_end_renders_min_width", () => {
    const root: TraceTreeNode = {
      ...node("r", at(0), at(1000)),
      children: [{ spanId: "open", traceId: "t1", name: "open", startTimeUnixNano: at(100), endTimeUnixNano: "", children: [] }],
    };
    const o = buildTimeline(root).get("open")!;
    expect(o.durationMs).toBe(0);
    expect(o.widthPct).toBeGreaterThanOrEqual(1);
    expect(Number.isNaN(o.widthPct)).toBe(false);
  });

  it("test_build_timeline_outlier_end_does_not_break_others", () => {
    const root = node("r", at(0), at(1000), [
      node("normal", at(100), at(200)),
      node("outlier", at(0), at(10_000_000)), // huge end
    ]);
    const tl = buildTimeline(root);
    expect(Number.isNaN(tl.get("normal")!.widthPct)).toBe(false);
    expect(tl.get("normal")!.widthPct).toBeGreaterThanOrEqual(1); // still floored/visible
  });
});
