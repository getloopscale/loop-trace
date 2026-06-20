import { describe, it, expect } from "vitest";
import { GEN_AI } from "./attributes.js";

describe("GEN_AI constants", () => {
  it("genai_constants_match_m1_reader_names", () => {
    // These literals MUST equal the names @usetheo/lens-core extractGenAi reads.
    expect(GEN_AI.REQUEST_MODEL).toBe("gen_ai.request.model");
    expect(GEN_AI.RESPONSE_MODEL).toBe("gen_ai.response.model");
    expect(GEN_AI.SYSTEM).toBe("gen_ai.system");
    expect(GEN_AI.USAGE_INPUT_TOKENS).toBe("gen_ai.usage.input_tokens");
    expect(GEN_AI.USAGE_OUTPUT_TOKENS).toBe("gen_ai.usage.output_tokens");
  });
});
