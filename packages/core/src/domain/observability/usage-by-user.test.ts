/**
 * M140 T2.1 — the response contract.
 *
 * The assertions that matter here are about what the schema REFUSES. A usage report whose
 * price-gap field can be omitted is a report that reads as complete while being silently low,
 * which is the exact failure the milestone exists to prevent.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

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

  /**
   * Asserts the schema refused for the RIGHT reason. A bare `.toThrow()` stays green when a
   * refactor throws a TypeError from an unrelated line — `rules/testing.md` § 4.1 asks a negative
   * case to pin the specific typed error, and here the failing FIELD is the behaviour under test.
   */
  const refuses = (parse: () => unknown, field: string) => {
    let err: unknown;
    try {
      parse();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(z.ZodError);
    expect((err as z.ZodError).issues.map((i) => i.path.join("."))).toContain(field);
  };

  it("REFUSES a response without unpricedSpans", () => {
    // Not optional by design: an omitted gap reads as "nothing missing".
    const { unpricedSpans: _omitted, ...withoutGap } = response;
    refuses(() => usageByUserResponseSchema.parse(withoutGap), "unpricedSpans");
  });

  it("REFUSES negative token counts", () => {
    // A negative count means the aggregation is wrong; failing loud beats rendering it (Rule 8).
    refuses(() => usageByUserRowSchema.parse({ ...row, inputTokens: -1 }), "inputTokens");
    refuses(() => usageByUserRowSchema.parse({ ...row, cacheReadTokens: -1 }), "cacheReadTokens");
  });

  it("REFUSES a fractional span count", () => {
    // Guards the numeric→Number conversion: `sum()` returns numeric, and a bad cast surfaces
    // here as a loud parse error instead of a fractional span reaching the consumer.
    refuses(() => usageByUserRowSchema.parse({ ...row, spans: 1.5 }), "spans");
  });

  it("REFUSES an empty userId", () => {
    // Empty string would render as a blank row indistinguishable from the unattributed bucket.
    refuses(() => usageByUserRowSchema.parse({ ...row, userId: "" }), "userId");
  });

  it("REFUSES a non-positive window", () => {
    refuses(() => usageByUserResponseSchema.parse({ ...response, windowDays: 0 }), "windowDays");
  });

  it("treats the unattributed bucket as an ordinary row", () => {
    // It must be sortable next to real users — the case worth seeing is it being the largest.
    const parsed = usageByUserRowSchema.parse({ ...row, userId: UNATTRIBUTED_USER_ID });
    expect(parsed.userId).toBe("unattributed");
  });
});
