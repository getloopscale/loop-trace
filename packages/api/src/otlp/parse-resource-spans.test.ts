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

  it("parse_applies_normalizeId_to_trace_span_parent_ids", () => {
    const withByteIds = {
      ...rawSpan,
      spanId: [44, 206, 24, 247],
      traceId: "ABCD",
      parentSpanId: { data: [1, 2] },
    };
    const span = parseResourceSpans(envelope([withByteIds]))[0];
    expect(span?.spanId).toBe("2cce18f7"); // byte array → hex
    expect(span?.traceId).toBe("abcd"); // hex string → lowercased
    expect(span?.parentSpanId).toBe("0102"); // {data} wrapper → hex
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
      ],
    };
    const span = parseResourceSpans(envelope([withAttrs]))[0];
    expect(span?.attributes).toEqual({ s: "x", i: "42", b: true, d: 1.5 });
  });

  it("flattenAttrs_recursively_flattens_arrayValue_to_js_array", () => {
    const withAttrs = {
      ...rawSpan,
      attributes: [
        {
          key: "gen_ai.prompt",
          value: {
            arrayValue: {
              values: [{ stringValue: "a" }, { intValue: "7" }],
            },
          },
        },
        { key: "empty", value: { arrayValue: {} } },
      ],
    };
    const span = parseResourceSpans(envelope([withAttrs]))[0];
    // arrayValue must become a real JS array, NOT the {values:[...]} wrapper.
    expect(span?.attributes?.["gen_ai.prompt"]).toEqual(["a", "7"]);
    expect(span?.attributes?.["empty"]).toEqual([]);
  });

  it("flattenAttrs_flattens_kvlistValue_to_object", () => {
    const withAttrs = {
      ...rawSpan,
      attributes: [
        {
          key: "meta",
          value: {
            kvlistValue: {
              values: [{ key: "nested", value: { stringValue: "v" } }],
            },
          },
        },
      ],
    };
    const span = parseResourceSpans(envelope([withAttrs]))[0];
    expect(span?.attributes?.["meta"]).toEqual({ nested: "v" });
  });

  it("flattenAttrs_degrades_unknown_value_kind_to_string_not_wrapper", () => {
    const withAttrs = {
      ...rawSpan,
      attributes: [{ key: "weird", value: { somethingNew: 1 } }],
    };
    const span = parseResourceSpans(envelope([withAttrs]))[0];
    // never persist an opaque wrapper object for an unknown kind
    expect(typeof span?.attributes?.["weird"]).toBe("string");
  });

  it("parse_throws_OtlpParseError_on_malformed_span", () => {
    const bad = { ...rawSpan, spanId: "" };
    expect(() => parseResourceSpans(envelope([bad]))).toThrow(OtlpParseError);
  });

  it("parse_attaches_model_and_tokens_from_genai_attrs", () => {
    const span = parseResourceSpans(
      envelope([
        {
          ...rawSpan,
          attributes: [
            { key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
            { key: "gen_ai.usage.input_tokens", value: { intValue: "10" } },
            { key: "gen_ai.usage.output_tokens", value: { intValue: "5" } },
            { key: "gen_ai.system", value: { stringValue: "openai" } },
          ],
        },
      ]),
    )[0];
    expect(span?.model).toBe("gpt-4o");
    expect(span?.inputTokens).toBe(10);
    expect(span?.outputTokens).toBe(5);
    expect(span?.provider).toBe("openai");
  });

  it("parse_attaches_kind_and_status_message", () => {
    const span = parseResourceSpans(
      envelope([
        { ...rawSpan, kind: 3, status: { code: 2, message: "boom" } },
      ]),
    )[0];
    expect(span?.kind).toBe("3");
    expect(span?.statusCode).toBe("2");
    expect(span?.statusMessage).toBe("boom");
  });

  it("parse_span_without_genai_attrs_has_no_genai_fields", () => {
    const span = parseResourceSpans(envelope([rawSpan]))[0];
    expect(span?.model).toBeUndefined();
    expect(span?.inputTokens).toBeUndefined();
  });
});
