import { describe, it, expect } from "vitest";
import {
  traceListItemSchema,
  traceListResponseSchema,
  listTracesOptionsSchema,
  LIST_TRACES_LIMIT_CAP,
} from "./trace-list.js";

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

  it("trace_list_schema_accepts_optional_enriched_fields", () => {
    // M18 — enriched columns are all optional + additive; the strict contract holds.
    const enriched = {
      traceId: "t1",
      name: "checkout",
      model: "gpt-4o",
      costUsd: 0.0123,
      rootOperationName: "chat",
      rootToolName: "search_web",
      endTimeUnixNano: "1700000000100000000",
      inputPreview: "the user prompt",
      outputPreview: "the answer",
    };
    expect(traceListItemSchema.safeParse(enriched).success).toBe(true);
    expect(traceListItemSchema.safeParse({ traceId: "t1" }).success).toBe(true);
    // .strict() still rejects an unknown column even alongside enriched fields.
    expect(
      traceListItemSchema.safeParse({ traceId: "t1", model: "x", bogus: 1 })
        .success,
    ).toBe(false);
  });

  it("trace_list_response_wraps_an_array", () => {
    expect(traceListResponseSchema.safeParse({ traces: [] }).success).toBe(true);
    expect(
      traceListResponseSchema.safeParse({ traces: [{ traceId: "t1" }] }).success,
    ).toBe(true);
  });
});

describe("listTracesOptionsSchema (M9)", () => {
  it("test_list_options_schema_accepts_whitelisted_values", () => {
    const parsed = listTracesOptionsSchema.parse({
      status: "error",
      orderBy: "latency",
      dir: "asc",
      model: "gpt-4o",
      from: "2026-06-01T00:00:00Z",
      to: "2026-06-22T00:00:00Z",
      limit: "100",
      format: "csv",
    });
    expect(parsed.status).toBe("error");
    expect(parsed.orderBy).toBe("latency");
    expect(parsed.limit).toBe(100); // coerced from a query-string
  });

  it("test_list_options_schema_rejects_unknown_enum", () => {
    expect(() => listTracesOptionsSchema.parse({ orderBy: "banana" })).toThrow();
    expect(() => listTracesOptionsSchema.parse({ status: "maybe" })).toThrow();
  });

  it("test_list_options_schema_caps_limit", () => {
    expect(() =>
      listTracesOptionsSchema.parse({ limit: LIST_TRACES_LIMIT_CAP + 1 }),
    ).toThrow();
    expect(() => listTracesOptionsSchema.parse({ limit: 0 })).toThrow();
  });

  it("test_list_options_schema_empty_is_valid", () => {
    expect(listTracesOptionsSchema.parse({})).toEqual({});
  });

  it("test_list_options_schema_coerces_cost_token_ranges (M52)", () => {
    const parsed = listTracesOptionsSchema.parse({
      minCostUsd: "1.5",
      maxCostUsd: "10",
      minTokens: "100",
      maxTokens: "5000",
      sessionId: "sess-abc",
    });
    expect(parsed.minCostUsd).toBe(1.5); // coerced from a query-string
    expect(parsed.maxTokens).toBe(5000);
    expect(parsed.sessionId).toBe("sess-abc");
    expect(listTracesOptionsSchema.parse({ minCostUsd: "0" }).minCostUsd).toBe(0); // a 0 bound is valid
  });

  it("test_list_options_schema_rejects_bad_advanced_filters (M52)", () => {
    expect(() => listTracesOptionsSchema.parse({ minCostUsd: "abc" })).toThrow(); // NaN
    expect(() => listTracesOptionsSchema.parse({ minTokens: "-5" })).toThrow(); // nonnegative
    expect(() => listTracesOptionsSchema.parse({ minTokens: "1.5" })).toThrow(); // int
    expect(() => listTracesOptionsSchema.parse({ sessionId: "" })).toThrow(); // min(1)
  });

  it("test_list_options_schema_accepts_span_query", () => {
    // M30: spanQuery is a free-form string (the parser, not zod, is the grammar).
    const parsed = listTracesOptionsSchema.parse({ spanQuery: "kind:llm status:error" });
    expect(parsed.spanQuery).toBe("kind:llm status:error");
    // still strict — an unknown field is rejected
    expect(() =>
      listTracesOptionsSchema.parse({ spanQueryTypo: "x" }),
    ).toThrow();
  });
});
