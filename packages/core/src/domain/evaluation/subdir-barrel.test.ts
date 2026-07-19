import { describe, expect, it } from "vitest";

import { evaluateRule } from "./evaluator.js";
import { evaluateRule as viaBarrel } from "./index.js";

/**
 * M123 findability regroup: the evaluation feature-subdir barrel re-exports its
 * members. This asserts the subdir seam resolves and points at the same defined
 * symbol as the direct import (a pure move — no behavior change).
 */
describe("M123 evaluation subdir barrel", () => {
  it("test_evaluator_resolves_from_evaluation_subdir", () => {
    expect(viaBarrel).toBe(evaluateRule);
    expect(typeof evaluateRule).toBe("function");
  });
});
