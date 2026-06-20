import { describe, it, expect } from "vitest";
import { computeTraceCost, type PriceTable } from "./pricing.js";
import { traceCostSchema, costByPeriodResponseSchema } from "./cost.js";

const table: PriceTable = {
  "gpt-4o": { inputPerToken: 5e-6, outputPerToken: 15e-6 },
  "claude-3-5-haiku": { inputPerToken: 0.8e-6, outputPerToken: 4e-6 },
};

describe("computeTraceCost", () => {
  it("compute_trace_cost_is_deterministic_per_model", () => {
    const usage = [{ model: "gpt-4o", inputTokens: 1000, outputTokens: 500 }];
    // 1000*5e-6 + 500*15e-6 = 0.005 + 0.0075 = 0.0125
    expect(computeTraceCost(usage, table)).toBe(0.0125);
    // idempotent / deterministic
    expect(computeTraceCost(usage, table)).toBe(computeTraceCost(usage, table));
  });

  it("compute_trace_cost_sums_multiple_models", () => {
    const usage = [
      { model: "gpt-4o", inputTokens: 1000, outputTokens: 0 },
      { model: "claude-3-5-haiku", inputTokens: 0, outputTokens: 1000 },
    ];
    // 0.005 + 0.004 = 0.009
    expect(computeTraceCost(usage, table)).toBe(0.009);
  });

  it("compute_trace_cost_unknown_model_contributes_zero", () => {
    expect(
      computeTraceCost([{ model: "mystery-llm", inputTokens: 9999, outputTokens: 9999 }], table),
    ).toBe(0);
    expect(computeTraceCost([], table)).toBe(0);
  });
});

describe("cost DTOs", () => {
  it("cost_dtos_strict_parse_and_reject_unknown_key", () => {
    expect(
      traceCostSchema.safeParse({
        traceId: "t1",
        costUsd: 0.0125,
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
      }).success,
    ).toBe(true);
    expect(traceCostSchema.safeParse({ traceId: "t1", bogus: 1 }).success).toBe(false);
    expect(
      costByPeriodResponseSchema.safeParse({ period: "day", buckets: [] }).success,
    ).toBe(true);
    expect(
      costByPeriodResponseSchema.safeParse({ period: "month", buckets: [] }).success,
    ).toBe(false);
  });
});
