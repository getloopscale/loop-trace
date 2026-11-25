import { describe, it, expect } from "vitest";
import { computeTraceCost, resolveModelPrice, type PriceTable } from "./pricing.js";
import { DEFAULT_PRICES } from "./default-prices.js";
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

  it("compute_trace_cost_prices_dated_snapshot_ids_by_longest_prefix", () => {
    const t: PriceTable = {
      "gpt-4o": { inputPerToken: 5e-6, outputPerToken: 15e-6 },
      "gpt-4o-mini": { inputPerToken: 0.15e-6, outputPerToken: 0.6e-6 },
    };
    // dated snapshot prices as its base model
    expect(
      computeTraceCost([{ model: "gpt-4o-2024-08-06", inputTokens: 1000, outputTokens: 0 }], t),
    ).toBe(0.005);
    // longest-prefix wins: a dated mini is NOT mispriced as the (pricier) gpt-4o
    expect(
      computeTraceCost([{ model: "gpt-4o-mini-2024-07-18", inputTokens: 1000, outputTokens: 0 }], t),
    ).toBe(0.00015);
  });

  it("compute_trace_cost_rounds_to_six_decimals", () => {
    const t: PriceTable = { m: { inputPerToken: 1e-9, outputPerToken: 0 } };
    // 1234 * 1e-9 = 0.000001234 → round6 → 0.000001
    expect(computeTraceCost([{ model: "m", inputTokens: 1234, outputTokens: 0 }], t)).toBe(0.000001);
  });

  it("compute_trace_cost_includes_cache_read_and_creation_tokens", () => {
    // looptrace#71 Finding 1: Claude Code caches heavily; cache tokens MUST be priced.
    // opus rates: input $5/M, output $25/M, cacheRead 0.1× input = $0.5/M, cacheCreation 1.25× = $6.25/M
    const t: PriceTable = {
      opus: {
        inputPerToken: 5e-6,
        outputPerToken: 25e-6,
        cacheReadPerToken: 0.5e-6,
        cacheCreationPerToken: 6.25e-6,
      },
    };
    // real trace shape (span cc50: 2 in / 529 out / 753582 cache-read / 976 cache-creation)
    // 2*5e-6 + 529*25e-6 + 753582*0.5e-6 + 976*6.25e-6
    // = 0.00001 + 0.013225 + 0.376791 + 0.0061 = 0.396126
    expect(
      computeTraceCost(
        [
          {
            model: "opus",
            inputTokens: 2,
            outputTokens: 529,
            cacheReadTokens: 753582,
            cacheCreationTokens: 976,
          },
        ],
        t,
      ),
    ).toBe(0.396126);
  });

  it("compute_trace_cost_omits_cache_when_price_lacks_cache_rate", () => {
    // Backward compat: a legacy price row without cache fields prices cache tokens at 0
    // (no crash, no NaN) — only input+output contribute.
    const t: PriceTable = { m: { inputPerToken: 5e-6, outputPerToken: 25e-6 } };
    expect(
      computeTraceCost(
        [{ model: "m", inputTokens: 100, outputTokens: 0, cacheReadTokens: 1_000_000 }],
        t,
      ),
    ).toBe(0.0005); // 100*5e-6 only; the 1M cache-read tokens contribute 0 (no rate)
  });

  it("compute_trace_cost_treats_missing_cache_tokens_as_zero", () => {
    // A priced-with-cache model but a usage with no cache token counts → cache contributes 0.
    const t: PriceTable = {
      m: { inputPerToken: 5e-6, outputPerToken: 25e-6, cacheReadPerToken: 0.5e-6 },
    };
    expect(computeTraceCost([{ model: "m", inputTokens: 100, outputTokens: 0 }], t)).toBe(0.0005);
  });
});

describe("default price table cache rates", () => {
  it("default_prices_derive_cache_rates_from_input_read_0_1x_creation_1_25x", () => {
    // looptrace#71 Finding 1: authoritative Anthropic multipliers (claude-api pricing ref):
    // cache-read = 0.1× input, cache-creation (ephemeral 5-min) = 1.25× input.
    const opus = DEFAULT_PRICES["claude-opus-4"];
    expect(opus.inputPerToken).toBe(5e-6); // Finding 2 WITHDRAWN — $5/M is the correct opus-4-8 rate
    expect(opus.cacheReadPerToken).toBeCloseTo(0.5e-6, 12);
    expect(opus.cacheCreationPerToken).toBeCloseTo(6.25e-6, 12);
  });
});

describe("opus-4-8 rate resolution (looptrace#71 Finding 2 — DoD regression)", () => {
  // The dated / context-window opus ids resolve to the current base key "claude-opus-4" = $5/$25 per M
  // via longest-prefix. A wrong constant (e.g. accidentally repricing to the legacy $15/$75) fails here.
  it("resolves_claude_opus_4_8_to_5_25_per_million", () => {
    const p = resolveModelPrice("claude-opus-4-8", DEFAULT_PRICES);
    expect(p?.inputPerToken).toBe(5e-6);
    expect(p?.outputPerToken).toBe(25e-6);
  });

  it("resolves_claude_opus_4_8_1m_context_variant_to_the_same_rate", () => {
    const p = resolveModelPrice("claude-opus-4-8[1m]", DEFAULT_PRICES);
    expect(p?.inputPerToken).toBe(5e-6);
    expect(p?.outputPerToken).toBe(25e-6);
  });

  it("legacy_claude_opus_4_1_still_routes_to_15_75_via_longer_key", () => {
    // Longest-prefix must NOT collapse the legacy Opus 4.1 into the current base rate.
    const p = resolveModelPrice("claude-opus-4-1-20250805", DEFAULT_PRICES);
    expect(p?.inputPerToken).toBe(15e-6);
    expect(p?.outputPerToken).toBe(75e-6);
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
