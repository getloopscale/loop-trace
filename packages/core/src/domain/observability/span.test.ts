import { describe, it, expect } from "vitest";
import { spanSchema } from "./span.js";

describe("spanSchema", () => {
  const base = {
    spanId: "a1",
    traceId: "t1",
    name: "op",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
  };

  it("span_schema_accepts_wellformed_root_span", () => {
    expect(spanSchema.parse(base)).toMatchObject(base);
  });

  it("span_schema_accepts_child_span", () => {
    const child = { ...base, parentSpanId: "p1" };
    expect(spanSchema.parse(child).parentSpanId).toBe("p1");
  });

  it("span_schema_rejects_empty_spanId", () => {
    expect(() => spanSchema.parse({ ...base, spanId: "" })).toThrow();
  });

  it("span_schema_rejects_nonnumeric_nanos", () => {
    expect(() =>
      spanSchema.parse({ ...base, startTimeUnixNano: "not-a-number" }),
    ).toThrow();
  });
});
