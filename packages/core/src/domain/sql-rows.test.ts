import { describe, expect, it } from "vitest";

import { bucketRowSchema as bucketSchema } from "./observability/north-star.js";
import { rowsAs } from "./sql-rows.js";

describe("rowsAs", () => {
  it("returns the typed rows when every row matches the schema", () => {
    const res = { rows: [{ bucket: "2026-07-10", count: 3 }, { bucket: "2026-07-11", count: 5 }] };
    expect(rowsAs(res, bucketSchema, "northStar")).toEqual(res.rows);
  });

  it("returns [] for an empty result", () => {
    expect(rowsAs({ rows: [] }, bucketSchema, "northStar")).toEqual([]);
  });

  it("throws loudly, naming the query + the offending field, on a shape mismatch (renamed column)", () => {
    // simulate a renamed SELECT alias: `count` came back as `cnt` → the row lacks `count`
    const res = { rows: [{ bucket: "2026-07-10", cnt: 3 }] };
    expect(() => rowsAs(res, bucketSchema, "northStar")).toThrowError(
      /rowsAs\(northStar\): row 0 failed SQL→DTO validation at "count"/,
    );
  });
});
