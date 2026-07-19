import { describe, it, expect } from "vitest";
import { extractGenAi } from "./genai-attributes.js";
import { INPUT_OUTPUT_CAP } from "./span-events.js";

describe("extractGenAi", () => {
  it("extract_reads_current_token_names", () => {
    expect(
      extractGenAi({
        "gen_ai.usage.input_tokens": "10",
        "gen_ai.usage.output_tokens": 20,
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 20 });
  });

  it("extract_reads_legacy_token_names", () => {
    expect(
      extractGenAi({
        "gen_ai.usage.prompt_tokens": "7",
        "gen_ai.usage.completion_tokens": "3",
      }),
    ).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it("extract_resolves_model_fallback_chain", () => {
    expect(extractGenAi({ "llm.model_name": "claude-x" }).model).toBe("claude-x");
    expect(
      extractGenAi({
        "gen_ai.response.model": "gpt-4o",
        "gen_ai.request.model": "gpt-4o-mini",
      }).model,
    ).toBe("gpt-4o"); // response.model wins
  });

  it("extract_reads_provider_from_gen_ai_system", () => {
    expect(extractGenAi({ "gen_ai.system": "openai" }).provider).toBe("openai");
  });

  it("extract_returns_empty_when_no_genai_attrs", () => {
    expect(extractGenAi({ "http.method": "POST" })).toEqual({});
    expect(extractGenAi(null)).toEqual({});
    expect(extractGenAi(undefined)).toEqual({});
  });

  it("test_extract_input_output_value_from_attrs", () => {
    expect(
      extractGenAi({ "input.value": "what is 2+2?", "output.value": "4" }),
    ).toEqual({ inputValue: "what is 2+2?", outputValue: "4" });
  });

  it("test_input_output_capped_at_8192_with_truncation_marker", () => {
    const out = extractGenAi({ "input.value": "a".repeat(9000) });
    expect([...out.inputValue!].length).toBeLessThanOrEqual(
      INPUT_OUTPUT_CAP + "…[truncated]".length,
    );
    expect(out.inputValue!.endsWith("…[truncated]")).toBe(true);
  });

  it("test_extract_only_extracts_string_input_output", () => {
    // EC-1: a non-string input.value is NOT extracted (stays for the bag).
    expect(extractGenAi({ "input.value": 42 }).inputValue).toBeUndefined();
    expect(extractGenAi({ "input.value": { a: 1 } }).inputValue).toBeUndefined();
  });

  it("test_extract_omits_empty_string_input_output", () => {
    // EC-7: "" is treated as absent (UI shows EmptyState, not a blank block).
    expect(extractGenAi({ "input.value": "", "output.value": "" })).toEqual({});
  });
});
