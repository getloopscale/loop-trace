import { describe, it, expect } from "vitest";
import { claudeCodeAdapter } from "./claude-code-adapter.js";
import { selectAdapter } from "./registry.js";
import { computeTraceCost } from "../pricing.js";
import { resolveModelPrice } from "../pricing.js";
import { DEFAULT_PRICES } from "../default-prices.js";

describe("claudeCodeAdapter (M15 D2/D3)", () => {
  it("test_claude_adapter_maps_bare_tokens", () => {
    // OTLP intValue flattens to a string; the adapter coerces it.
    const out = claudeCodeAdapter.extract(
      { input_tokens: "5380", output_tokens: "3" },
      "claude_code.llm_request",
    );
    expect(out.inputTokens).toBe(5380);
    expect(out.outputTokens).toBe(3);
  });

  it("test_claude_adapter_normalizes_model", () => {
    const out = claudeCodeAdapter.extract(
      { "gen_ai.request.model": "claude-opus-4-8[1m]", "gen_ai.system": "anthropic" },
      "claude_code.llm_request",
    );
    expect(out.model).toBe("claude-opus-4-8"); // suffix stripped
    expect(out.provider).toBe("anthropic");
  });

  it("test_claude_adapter_maps_user_prompt_to_input_value", () => {
    const out = claudeCodeAdapter.extract(
      { user_prompt: "What is 2+2?" },
      "claude_code.interaction",
    );
    expect(out.inputValue).toBe("What is 2+2?");
  });

  it("test_claude_adapter_degrades_on_missing_keys", () => {
    expect(() => claudeCodeAdapter.extract({}, "claude_code.interaction")).not.toThrow();
    expect(claudeCodeAdapter.extract(undefined, "x")).toEqual({});
  });

  it("test_claude_adapter_prefers_gen_ai_usage_when_present", () => {
    // EC-2: a future Claude carrying the standard key keeps it; bare is only fallback.
    const out = claudeCodeAdapter.extract(
      { "gen_ai.usage.input_tokens": "99", input_tokens: "5380" },
      "claude_code.llm_request",
    );
    expect(out.inputTokens).toBe(99);
  });

  it("test_claude_opus_4x_priced_at_current_rate", () => {
    // EXACT value guard (F-test-8): current Opus 4.6-4.8 list price is $5/$25 per 1M.
    // 1M in + 1M out → $5 + $25 = $30. Catches a future mis-priced typo (e.g. the
    // legacy $15/$75 that this assertion was added to prevent regressing to).
    const cost = computeTraceCost(
      [{ model: "claude-opus-4-8", inputTokens: 1_000_000, outputTokens: 1_000_000 }],
      DEFAULT_PRICES,
    );
    expect(cost).toBe(30);
  });

  it("test_claude_4x_prices_do_not_collide_with_claude_3", () => {
    // EC-3: longest-prefix resolves each to its own price, no cross-collision.
    expect(resolveModelPrice("claude-opus-4-8", DEFAULT_PRICES)).toEqual(
      resolveModelPrice("claude-opus-4", DEFAULT_PRICES),
    );
    expect(resolveModelPrice("claude-3-opus", DEFAULT_PRICES)).toEqual(
      DEFAULT_PRICES["claude-3-opus"],
    );
    // a context-window suffix still prices via prefix even unstripped.
    expect(resolveModelPrice("claude-opus-4-8[1m]", DEFAULT_PRICES)).toEqual(
      DEFAULT_PRICES["claude-opus-4"],
    );
    // legacy Opus 4.1 routes to its own (higher) rate via the longer key, NOT the
    // current base rate (longest-prefix).
    expect(resolveModelPrice("claude-opus-4-1-20250805", DEFAULT_PRICES)).toEqual(
      DEFAULT_PRICES["claude-opus-4-1"],
    );
    expect(DEFAULT_PRICES["claude-opus-4-1"]).not.toEqual(DEFAULT_PRICES["claude-opus-4"]);
  });

  it("test_select_adapter_picks_claude_by_service_name", () => {
    expect(selectAdapter({ "service.name": "claude-code" }).name).toBe("claude-code");
  });
});
