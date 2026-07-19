import { describe, it, expect } from "vitest";
import { shapeObservability } from "./observability.js";
import { DEFAULT_PRICES } from "./default-prices.js";
import { computeTraceCost } from "./pricing.js";
import { round3 } from "./tool-stats.js";

const empty = { traffic: [], latency: [], tokensByModel: [] };

describe("shapeObservability (M11)", () => {
  it("test_shape_observability_computes_error_rate_with_zero_guard", () => {
    const out = shapeObservability(
      {
        ...empty,
        traffic: [
          { bucket: "2026-06-22T00:00:00Z", traceCount: 4, errorCount: 1 },
          { bucket: "2026-06-22T01:00:00Z", traceCount: 0, errorCount: 0 },
        ],
      },
      "24h",
      DEFAULT_PRICES,
    );
    expect(out.traffic[0]?.errorRate).toBe(0.25);
    expect(out.traffic[1]?.errorRate).toBe(0); // no NaN on zero traceCount
  });

  it("test_shape_observability_costs_tokens_by_model_via_price_table", () => {
    const out = shapeObservability(
      {
        ...empty,
        tokensByModel: [
          {
            bucket: "2026-06-22T00:00:00Z",
            model: "gpt-4o",
            inputTokens: 1000,
            outputTokens: 1000,
          },
        ],
      },
      "24h",
      DEFAULT_PRICES,
    );
    expect(out.tokensByModel[0]?.totalTokens).toBe(2000);
    // Exact cost = the price-table result (D2), not merely >0 — a mispricing /
    // swapped-rate / wrong-model-lookup regression would change this value (F-test-3).
    const expectedCost = round3(
      computeTraceCost(
        [{ model: "gpt-4o", inputTokens: 1000, outputTokens: 1000 }],
        DEFAULT_PRICES,
      ),
    );
    expect(expectedCost).toBeGreaterThan(0); // guard: the price table actually prices gpt-4o
    expect(out.tokensByModel[0]?.costUsd).toBe(expectedCost);
  });

  it("test_shape_observability_rounds_error_rate_and_cost", () => {
    const out = shapeObservability(
      {
        ...empty,
        traffic: [{ bucket: "2026-06-22T00:00:00Z", traceCount: 3, errorCount: 1 }],
        // odd token counts → a float-noisy raw cost that round3 must trim.
        tokensByModel: [
          {
            bucket: "2026-06-22T00:00:00Z",
            model: "gpt-4o",
            inputTokens: 777,
            outputTokens: 333,
          },
        ],
      },
      "24h",
      DEFAULT_PRICES,
    );
    // 1/3 = 0.3333… must be round3-ed, not leak float noise.
    expect(out.traffic[0]?.errorRate).toBe(0.333);
    // cost is round3-ed too: at most 3 decimal places (no float tail).
    const cost = out.tokensByModel[0]!.costUsd;
    expect(cost).toBeGreaterThan(0);
    expect(Number.isInteger(Math.round(cost * 1000))).toBe(true);
    expect(cost).toBe(Math.round(cost * 1000) / 1000);
  });

  it("test_shape_observability_maps_bucket_to_iso_date", () => {
    const out = shapeObservability(
      {
        ...empty,
        latency: [
          { bucket: new Date("2026-06-22T00:00:00Z"), p50: 10, p75: 20, p95: 40, p99: 99 },
        ],
      },
      "7d",
      DEFAULT_PRICES,
    );
    expect(out.latency[0]?.periodStart).toBe("2026-06-22T00:00:00.000Z");
    expect(out.range).toBe("7d");
  });

  it("test_shape_observability_empty_is_valid", () => {
    const out = shapeObservability(empty, "1h", DEFAULT_PRICES);
    expect(out).toEqual({ range: "1h", traffic: [], latency: [], tokensByModel: [] });
  });
});
