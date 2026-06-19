import { describe, it, expect } from "vitest";
import { parseResourceSpans, OtlpParseError } from "./parse-resource-spans.js";

function envelope(spans: unknown[]): unknown {
  return { resourceSpans: [{ scopeSpans: [{ spans }] }] };
}

const rawSpan = {
  spanId: "a1",
  traceId: "t1",
  name: "op",
  startTimeUnixNano: "1700000000000000000",
  endTimeUnixNano: "1700000000100000000",
};

describe("parseResourceSpans", () => {
  it("parse_extracts_single_span_from_envelope", () => {
    const spans = parseResourceSpans(envelope([rawSpan]));
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ spanId: "a1", traceId: "t1", name: "op" });
  });

  it("parse_returns_empty_for_empty_resourceSpans", () => {
    expect(parseResourceSpans({ resourceSpans: [] })).toEqual([]);
    expect(parseResourceSpans({})).toEqual([]);
    expect(parseResourceSpans(null)).toEqual([]);
  });

  it("parse_flattens_otlp_attributes_to_object", () => {
    const withAttrs = {
      ...rawSpan,
      attributes: [{ key: "service.name", value: { stringValue: "probe" } }],
    };
    const spans = parseResourceSpans(envelope([withAttrs]));
    expect(spans[0]?.attributes).toEqual({ "service.name": "probe" });
  });

  it("flattenAttrs_handles_string_int_bool_double_values", () => {
    const withAttrs = {
      ...rawSpan,
      attributes: [
        { key: "s", value: { stringValue: "x" } },
        { key: "i", value: { intValue: "42" } },
        { key: "b", value: { boolValue: true } },
        { key: "d", value: { doubleValue: 1.5 } },
        { key: "arr", value: { arrayValue: { values: [] } } },
      ],
    };
    const span = parseResourceSpans(envelope([withAttrs]))[0];
    expect(span?.attributes).toMatchObject({
      s: "x",
      i: "42",
      b: true,
      d: 1.5,
    });
    // unknown/array value kept raw, no throw
    expect(span?.attributes?.["arr"]).toBeDefined();
  });

  it("parse_throws_OtlpParseError_on_malformed_span", () => {
    const bad = { ...rawSpan, spanId: "" };
    expect(() => parseResourceSpans(envelope([bad]))).toThrow(OtlpParseError);
  });
});
