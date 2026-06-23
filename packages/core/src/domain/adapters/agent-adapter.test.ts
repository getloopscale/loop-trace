import { describe, it, expect } from "vitest";
import { stripContextWindowSuffix, serviceNameOf } from "./agent-adapter.js";
import { defaultAdapter } from "./default-adapter.js";
import { selectAdapter } from "./registry.js";
import { extractGenAi } from "../genai-attributes.js";

describe("agent adapter seam (M15 D1)", () => {
  it("test_default_adapter_extracts_identically_to_extractGenAi", () => {
    // Exhaustive sample (F-test-3): exercises every extractGenAi branch — model
    // fallback (llm.*), provider, current + legacy token names, tool name, and
    // both input/output value — so the zero-regression guard is not single-branch.
    const samples = [
      {
        "gen_ai.request.model": "gpt-4o",
        "gen_ai.system": "openai",
        "gen_ai.usage.input_tokens": "100",
        "gen_ai.usage.output_tokens": 50,
        "input.value": "hi",
        "output.value": "yo",
      },
      {
        "llm.model_name": "claude-x",
        "gen_ai.provider.name": "anthropic",
        "gen_ai.usage.prompt_tokens": "7", // legacy
        "gen_ai.usage.completion_tokens": "3", // legacy
        "gen_ai.tool.name": "  search  ",
      },
      { "http.method": "POST" }, // no gen_ai → {}
    ];
    for (const attrs of samples) {
      expect(defaultAdapter.extract(attrs, "op")).toEqual(extractGenAi(attrs));
    }
  });

  it("test_select_adapter_falls_back_to_default", () => {
    expect(selectAdapter({ "service.name": "some-other-agent" }).name).toBe("default");
    expect(selectAdapter(undefined).name).toBe("default");
    expect(selectAdapter({}).name).toBe("default");
  });

  it("test_strip_context_window_suffix", () => {
    expect(stripContextWindowSuffix("claude-opus-4-8[1m]")).toBe("claude-opus-4-8");
    expect(stripContextWindowSuffix("claude-opus-4-8[200k]")).toBe("claude-opus-4-8");
    expect(stripContextWindowSuffix("gpt-4o")).toBe("gpt-4o"); // no-op
  });

  it("test_service_name_of", () => {
    expect(serviceNameOf({ "service.name": "claude-code" })).toBe("claude-code");
    expect(serviceNameOf({})).toBeUndefined();
    expect(serviceNameOf(undefined)).toBeUndefined();
  });
});
