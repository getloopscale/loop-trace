import { describe, it, expect } from "vitest";
import { computeToolStats, percentile } from "./tool-stats.js";
import { extractGenAi } from "./genai-attributes.js";

describe("percentile", () => {
  it("percentile_interpolates_and_handles_empty_and_single", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([42], 0.95)).toBe(42);
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25); // interpolated midpoint
    expect(percentile([10, 20, 30, 40], 0)).toBe(10);
    expect(percentile([10, 20, 30, 40], 1)).toBe(40);
  });
});

describe("computeToolStats", () => {
  it("compute_tool_stats_is_deterministic_for_known_samples", () => {
    const stat = computeToolStats("search", [
      { durationMs: 10, errored: false },
      { durationMs: 20, errored: false },
      { durationMs: 30, errored: true },
      { durationMs: 40, errored: false },
    ]);
    expect(stat).toEqual({
      toolName: "search",
      callCount: 4,
      errorCount: 1,
      errorRate: 0.25,
      p50Ms: 25, // percentile([10,20,30,40], 0.5)
      p95Ms: 38.5, // percentile([10,20,30,40], 0.95) = 30 + (40-30)*0.85
    });
    // deterministic / idempotent (input order independent — sorted internally)
    expect(
      computeToolStats("search", [
        { durationMs: 40, errored: false },
        { durationMs: 30, errored: true },
        { durationMs: 20, errored: false },
        { durationMs: 10, errored: false },
      ]),
    ).toEqual(stat);
  });

  it("compute_tool_stats_zeros_for_no_samples", () => {
    expect(computeToolStats("idle", [])).toEqual({
      toolName: "idle",
      callCount: 0,
      errorCount: 0,
      errorRate: 0,
      p50Ms: 0,
      p95Ms: 0,
    });
  });
});

describe("extractGenAi toolName", () => {
  it("extract_genai_extracts_trimmed_tool_name", () => {
    expect(extractGenAi({ "gen_ai.tool.name": "  search-products  " }).toolName).toBe(
      "search-products",
    );
    // blank / whitespace-only → omitted
    expect(extractGenAi({ "gen_ai.tool.name": "   " }).toolName).toBeUndefined();
    expect(extractGenAi({ model: "gpt-4o" }).toolName).toBeUndefined();
  });
});
