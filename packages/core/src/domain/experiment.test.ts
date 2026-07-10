import { describe, it, expect } from "vitest";

import {
  aggregateRun,
  compareRuns,
  type ExperimentRunItem,
  type RunAggregate,
} from "./experiment.js";

function item(over: Partial<ExperimentRunItem>): ExperimentRunItem {
  return {
    datasetItemTraceId: "t1",
    output: "out",
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    latencyMs: 100,
    model: "m",
    scores: [],
    ...over,
  };
}

describe("M64 aggregateRun (pure)", () => {
  it("test_aggregateRun_computes_passrate_avgscore_totalcost", () => {
    const a = aggregateRun([
      item({ scores: [{ name: "acc", score: 1, label: "pass" }], costUsd: 0.001 }),
      item({ scores: [{ name: "acc", score: 0, label: "fail" }], costUsd: 0.002 }),
      item({ scores: [{ name: "acc", score: 0.8 }], costUsd: 0.003 }),
    ]);
    expect(a.itemCount).toBe(3);
    expect(a.passCount).toBe(2); // score >= 0.5 → 1.0 and 0.8 pass; 0.0 fails
    expect(a.avgScore).toBeCloseTo((1 + 0 + 0.8) / 3, 5);
    expect(a.totalCostUsd).toBeCloseTo(0.006, 6);
    expect(a.avgLatencyMs).toBe(100);
  });

  it("test_aggregateRun_handles_empty_and_missing_scores (never NaN)", () => {
    const empty = aggregateRun([]);
    expect(empty).toEqual({ itemCount: 0, passCount: 0, avgScore: undefined, totalCostUsd: 0, avgLatencyMs: undefined });
    // a row with no scores is not counted toward avgScore/passCount, never NaN
    const noScores = aggregateRun([item({ scores: [] }), item({ scores: [{ name: "x", score: 1 }] })]);
    expect(noScores.itemCount).toBe(2);
    expect(noScores.passCount).toBe(1); // only the scored row passes
    expect(noScores.avgScore).toBe(1); // mean over the ONE scored row (never NaN from the unscored one)
  });

  it("test_aggregateRun_totalCost_ignores_missing_costUsd", () => {
    const a = aggregateRun([item({ costUsd: 0.005 }), item({ costUsd: undefined })]);
    expect(a.totalCostUsd).toBeCloseTo(0.005, 6); // absent cost contributes 0, never NaN
  });

  it("test_aggregateRun_score_exactly_at_threshold_passes (0.5 boundary)", () => {
    // a row whose mean score is EXACTLY 0.5 passes (>=), pinning the inclusive boundary.
    const a = aggregateRun([item({ scores: [{ name: "acc", score: 0.5 }] })]);
    expect(a.passCount).toBe(1);
  });
});

describe("M64 compareRuns (pure)", () => {
  const A: RunAggregate = { itemCount: 3, passCount: 3, avgScore: 0.9, totalCostUsd: 0.006, avgLatencyMs: 100 };
  const B: RunAggregate = { itemCount: 3, passCount: 1, avgScore: 0.4, totalCostUsd: 0.009, avgLatencyMs: 150 };

  it("test_compareRuns_computes_signed_deltas", () => {
    const d = compareRuns(A, B);
    expect(d.passCountDelta).toBe(2); // A has 2 more passing rows
    expect(d.passRateDelta).toBeCloseTo(3 / 3 - 1 / 3, 5); // pass-RATE delta (DoD3 aggregate): 1.0 − 0.333
    expect(d.avgScoreDelta).toBeCloseTo(0.5, 5);
    expect(d.totalCostDelta).toBeCloseTo(-0.003, 6); // A is cheaper
    expect(d.avgLatencyDelta).toBe(-50);
  });

  it("test_compareRuns_passRate_never_NaN_on_empty_run", () => {
    const empty: RunAggregate = { itemCount: 0, passCount: 0, avgScore: undefined, totalCostUsd: 0, avgLatencyMs: undefined };
    const d = compareRuns(empty, empty);
    expect(d.passRateDelta).toBe(0); // 0-item runs → rate 0, delta 0 (never NaN)
  });

  it("test_compareRuns_null_delta_when_a_metric_absent (never fabricated)", () => {
    const noScore: RunAggregate = { itemCount: 1, passCount: 0, avgScore: undefined, totalCostUsd: 0, avgLatencyMs: undefined };
    const d = compareRuns(A, noScore);
    expect(d.avgScoreDelta).toBeNull(); // B has no avgScore → the delta is null, not a fabricated number
    expect(d.avgLatencyDelta).toBeNull();
    expect(d.passCountDelta).toBe(3); // counts are always present
  });
});
