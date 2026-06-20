import { describe, it, expect } from "vitest";
import { traceListItemSchema, traceListResponseSchema } from "./trace-list.js";

describe("trace-list DTO", () => {
  it("trace_list_schema_parses_valid_item_and_rejects_unknown_key", () => {
    const valid = {
      traceId: "t1",
      name: "checkout",
      startTimeUnixNano: "1700000000000000000",
      durationMs: 123,
      statusCode: "OK",
      totalTokens: 16,
    };
    expect(traceListItemSchema.safeParse(valid).success).toBe(true);
    // strict: a stray Drizzle-ish column must be rejected (risk #2 guard).
    expect(
      traceListItemSchema.safeParse({ traceId: "t1", cost_usd: 0.01 }).success,
    ).toBe(false);
  });

  it("trace_list_response_wraps_an_array", () => {
    expect(traceListResponseSchema.safeParse({ traces: [] }).success).toBe(true);
    expect(
      traceListResponseSchema.safeParse({ traces: [{ traceId: "t1" }] }).success,
    ).toBe(true);
  });
});
