import { describe, it, expect } from "vitest";
import { stripContextWindowSuffix, serviceNameOf } from "./agent-adapter.js";
import { defaultAdapter } from "./default-adapter.js";
import { selectAdapter } from "./registry.js";
import { extractGenAi } from "../genai-attributes.js";

describe("agent adapter seam (M15 D1)", () => {
  it("test_default_adapter_extracts_identically_to_extractGenAi", () => {
    const attrs = {
      "gen_ai.request.model": "gpt-4o",
      "gen_ai.system": "openai",
      "gen_ai.usage.input_tokens": "100",
      "gen_ai.usage.output_tokens": 50,
      "input.value": "hi",
    };
    expect(defaultAdapter.extract(attrs, "op")).toEqual(extractGenAi(attrs));
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
