import { describe, it, expect } from "vitest";
import { theokitSdkAdapter } from "./theokit-sdk-adapter.js";
import { selectAdapter } from "./registry.js";

describe("theokitSdkAdapter (M115)", () => {
  it("test_theokit_adapter_matches_service_name", () => {
    expect(theokitSdkAdapter.matches({ "service.name": "theokit-sdk" })).toBe(true);
    expect(theokitSdkAdapter.matches({ "service.name": "claude-code" })).toBe(false);
    expect(theokitSdkAdapter.matches({})).toBe(false);
  });

  it("test_theokit_adapter_registered_and_selected_by_registry", () => {
    expect(selectAdapter({ "service.name": "theokit-sdk" })).toBe(theokitSdkAdapter);
    // A theokit resource does NOT accidentally select claude-code.
    expect(selectAdapter({ "service.name": "theokit-sdk" }).name).toBe("theokit-sdk");
  });

  it("test_theokit_adapter_delegates_standard_genai_to_default", () => {
    const out = theokitSdkAdapter.extract(
      {
        "gen_ai.request.model": "claude-opus-4-8",
        "gen_ai.system": "anthropic",
        "gen_ai.usage.input_tokens": "120",
        "gen_ai.usage.output_tokens": "34",
        "gen_ai.tool.name": "Bash",
        "input.value": "run ls",
        "output.value": "file.txt",
      },
      "agent.run",
    );
    expect(out.model).toBe("claude-opus-4-8");
    expect(out.provider).toBe("anthropic");
    expect(out.inputTokens).toBe(120);
    expect(out.outputTokens).toBe(34);
    expect(out.toolName).toBe("Bash");
    expect(out.inputValue).toBe("run ls");
    expect(out.outputValue).toBe("file.txt");
  });

  it("test_theokit_adapter_overlays_cache_tokens", () => {
    const out = theokitSdkAdapter.extract(
      {
        "gen_ai.usage.cache_read_input_tokens": "500",
        "gen_ai.usage.cache_creation_input_tokens": "80",
      },
      "agent.run",
    );
    expect(out.cacheReadTokens).toBe(500);
    expect(out.cacheCreationTokens).toBe(80);
  });

  it("test_theokit_adapter_degrades_on_missing_keys", () => {
    expect(() => theokitSdkAdapter.extract({}, "x")).not.toThrow();
    expect(theokitSdkAdapter.extract(undefined, "x")).toEqual({});
  });
});
