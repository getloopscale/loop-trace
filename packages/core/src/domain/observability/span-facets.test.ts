import { describe, it, expect } from "vitest";
import { spanFacetsResponseSchema } from "./span-facets.js";

describe("spanFacetsResponseSchema (M92)", () => {
  it("round-trips the keys mode", () => {
    const payload = { mode: "keys", keys: [{ key: "tier", count: 3 }] };
    expect(spanFacetsResponseSchema.parse(payload)).toEqual(payload);
  });

  it("round-trips the values mode", () => {
    const payload = { mode: "values", key: "tier", values: [{ value: "gold", count: 2 }] };
    expect(spanFacetsResponseSchema.parse(payload)).toEqual(payload);
  });

  it("rejects an unknown column (strict, no-leak invariant)", () => {
    expect(() =>
      spanFacetsResponseSchema.parse({ mode: "keys", keys: [{ key: "x", count: 1, span_id: "leak" }] }),
    ).toThrow();
  });

  it("rejects a negative count and an unknown mode", () => {
    expect(() => spanFacetsResponseSchema.parse({ mode: "keys", keys: [{ key: "x", count: -1 }] })).toThrow();
    expect(() => spanFacetsResponseSchema.parse({ mode: "bogus", keys: [] })).toThrow();
  });
});
