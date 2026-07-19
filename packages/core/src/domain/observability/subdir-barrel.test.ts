import { describe, expect, it } from "vitest";

import { spanSchema } from "./index.js";
import { spanSchema as spanDirect } from "./span.js";

/**
 * M123 findability regroup: the observability feature-subdir barrel re-exports
 * its members. This asserts the subdir seam resolves and points at the same
 * defined symbol as the direct import (a pure move — no behavior change).
 */
describe("M123 observability subdir barrel", () => {
  it("test_span_resolves_from_observability_subdir", () => {
    expect(spanSchema).toBe(spanDirect);
    expect(spanSchema).toBeDefined();
  });
});
