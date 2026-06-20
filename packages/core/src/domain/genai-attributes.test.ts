import { describe, it, expect } from "vitest";
import { extractGenAi } from "./genai-attributes.js";

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
});
