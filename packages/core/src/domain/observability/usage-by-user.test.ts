/**
 * M140 T2.1 — the response contract.
 *
 * The assertions that matter here are about what the schema REFUSES. A usage report whose
 * price-gap field can be omitted is a report that reads as complete while being silently low,
 * which is the exact failure the milestone exists to prevent.
 */
import { describe, expect, it } from "vitest";

import {
  UNATTRIBUTED_USER_ID,
  usageByUserResponseSchema,
  usageByUserRowSchema,
} from "./usage-by-user.js";

const row = {
  userId: "u-1",
  spans: 3,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0.0123,
};

const response = { users: [row], unpricedSpans: 0, totalUsers: 1, windowDays: 30 };

describe("M140 — usageByUser response contract", () => {
  it("accepts a well-formed response", () => {
    expect(usageByUserResponseSchema.parse(response)).toEqual(response);
  });

  it("REFUSES a response without unpricedSpans", () => {
    // Not optional by design: an omitted gap reads as "nothing missing".
    const { unpricedSpans: _omitted, ...withoutGap } = response;
    expect(() => usageByUserResponseSchema.parse(withoutGap)).toThrow();
  });

  it("REFUSES negative token counts", () => {
    // A negative count means the aggregation is wrong; failing loud beats rendering it (Rule 8).
    expect(() => usageByUserRowSchema.parse({ ...row, inputTokens: -1 })).toThrow();
    expect(() => usageByUserRowSchema.parse({ ...row, cacheReadTokens: -1 })).toThrow();
  });

  it("REFUSES a fractional span count", () => {
    // Guards the numeric→Number conversion: `sum()` returns numeric, and a bad cast surfaces
    // here as a loud parse error instead of a fractional span reaching the consumer.
    expect(() => usageByUserRowSchema.parse({ ...row, spans: 1.5 })).toThrow();
  });

  it("REFUSES an empty userId", () => {
    // Empty string would render as a blank row indistinguishable from the unattributed bucket.
    expect(() => usageByUserRowSchema.parse({ ...row, userId: "" })).toThrow();
  });

  it("REFUSES a non-positive window", () => {
    expect(() => usageByUserResponseSchema.parse({ ...response, windowDays: 0 })).toThrow();
  });

  it("treats the unattributed bucket as an ordinary row", () => {
    // It must be sortable next to real users — the case worth seeing is it being the largest.
    const parsed = usageByUserRowSchema.parse({ ...row, userId: UNATTRIBUTED_USER_ID });
    expect(parsed.userId).toBe("unattributed");
  });
});
