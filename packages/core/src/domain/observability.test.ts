import { describe, it, expect } from "vitest";
import { shapeObservability } from "./observability.js";
import { DEFAULT_PRICES } from "./default-prices.js";

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
    expect(out.tokensByModel[0]?.costUsd).toBeGreaterThan(0); // priced model → real cost
  });

  it("test_shape_observability_rounds_error_rate_and_cost", () => {
    const out = shapeObservability(
      {
        ...empty,
        traffic: [{ bucket: "2026-06-22T00:00:00Z", traceCount: 3, errorCount: 1 }],
      },
      "24h",
      DEFAULT_PRICES,
    );
    // 1/3 = 0.3333… must be round3-ed, not leak float noise.
    expect(out.traffic[0]?.errorRate).toBe(0.333);
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
