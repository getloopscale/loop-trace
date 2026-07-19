import { describe, expect, it } from "vitest";

import { shapeNorthStarBuckets } from "./north-star.js";

describe("shapeNorthStarBuckets", () => {
  it("test_shape_north_star_buckets_maps_rows_to_dto", () => {
    const out = shapeNorthStarBuckets([
      { bucket: new Date("2026-06-22T00:00:00Z"), count: 5 },
      { bucket: "2026-06-21T00:00:00Z", count: 2 },
    ]);
    expect(out).toEqual([
      { period: "2026-06-22", count: 5 },
      { period: "2026-06-21", count: 2 },
    ]);
  });

  it("test_shape_north_star_buckets_coerces_count_to_nonnegative_int", () => {
    const out = shapeNorthStarBuckets([
      { bucket: "2026-06-22T00:00:00Z", count: 3.9 as unknown as number },
    ]);
    expect(out[0]?.count).toBe(3);
  });

  it("test_shape_north_star_buckets_empty", () => {
    expect(shapeNorthStarBuckets([])).toEqual([]);
  });

  it("test_shape_north_star_buckets_tolerates_invalid_bucket", () => {
    // An unparseable bucket must not throw RangeError from toISOString (F-data-2).
    expect(() =>
      shapeNorthStarBuckets([{ bucket: "not-a-date", count: 1 }]),
    ).not.toThrow();
    const out = shapeNorthStarBuckets([{ bucket: "not-a-date", count: 1 }]);
    expect(out[0]?.count).toBe(1);
  });
});
