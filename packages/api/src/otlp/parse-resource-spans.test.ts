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

  it("test_parse_extracts_input_output_and_strips_from_bag", () => {
    const withIo = {
      ...rawSpan,
      attributes: [
        { key: "input.value", value: { stringValue: "what is 2+2?" } },
        { key: "output.value", value: { stringValue: "4" } },
        { key: "service.name", value: { stringValue: "probe" } },
      ],
    };
    const span = parseResourceSpans(envelope([withIo]))[0];
    expect(span?.inputValue).toBe("what is 2+2?");
    expect(span?.outputValue).toBe("4");
    // moved out of the bag (D2/EC-8) — only the unrelated attr remains.
    expect(span?.attributes).toEqual({ "service.name": "probe" });
  });

  it("test_parse_keeps_non_string_input_value_in_bag", () => {
    // A kvlist flattens to an OBJECT (a genuinely non-string value). EC-1/EC-8:
    // not extracted to the typed field → NOT stripped, stays in the bag.
    const withNonString = {
      ...rawSpan,
      attributes: [
        {
          key: "input.value",
          value: { kvlistValue: { values: [{ key: "role", value: { stringValue: "user" } }] } },
        },
      ],
    };
    const span = parseResourceSpans(envelope([withNonString]))[0];
    expect(span?.inputValue).toBeUndefined();
    expect(span?.attributes).toEqual({ "input.value": { role: "user" } });
  });

  it("test_parse_extracts_span_events", () => {
    const withEvents = {
      ...rawSpan,
      events: [
        {
          name: "chunk",
          timeUnixNano: "1700000000050000000",
          attributes: [{ key: "i", value: { intValue: "1" } }],
        },
      ],
    };
    const span = parseResourceSpans(envelope([withEvents]))[0];
    expect(span?.events).toHaveLength(1);
    expect(span?.events?.[0]).toMatchObject({
      name: "chunk",
      timeUnixNano: "1700000000050000000",
      attributes: { i: "1" },
    });
  });

  it("test_parse_span_without_events_or_io_is_backward_compatible", () => {
    const span = parseResourceSpans(envelope([rawSpan]))[0];
    expect(span?.events).toBeUndefined();
    expect(span?.inputValue).toBeUndefined();
    expect(span?.outputValue).toBeUndefined();
  });

  // M15: adapter selection by service.name (resource-level).
  function envelopeWithService(service: string, spans: unknown[]): unknown {
    return {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: service } }] },
          scopeSpans: [{ spans }],
        },
      ],
    };
  }

  it("test_parse_selects_claude_adapter_by_service_name", () => {
    const claudeSpan = {
      ...rawSpan,
      attributes: [
        { key: "gen_ai.request.model", value: { stringValue: "claude-opus-4-8[1m]" } },
        { key: "gen_ai.system", value: { stringValue: "anthropic" } },
        { key: "input_tokens", value: { intValue: "5380" } },
        { key: "output_tokens", value: { intValue: "3" } },
      ],
    };
    const span = parseResourceSpans(envelopeWithService("claude-code", [claudeSpan]))[0];
    expect(span?.model).toBe("claude-opus-4-8"); // suffix stripped by the claude adapter
    expect(span?.provider).toBe("anthropic");
    expect(span?.inputTokens).toBe(5380); // bare keys mapped
    expect(span?.outputTokens).toBe(3);
  });

  it("test_parse_strips_user_prompt_from_bag_when_mapped", () => {
    // F-domain-2/PII: Claude's user_prompt → input.value column; the uncapped
    // duplicate must NOT remain in the persisted attributes bag.
    const span = {
      ...rawSpan,
      attributes: [
        { key: "user_prompt", value: { stringValue: "secret prompt text" } },
        { key: "span.type", value: { stringValue: "interaction" } },
      ],
    };
    const out = parseResourceSpans(envelopeWithService("claude-code", [span]))[0];
    expect(out?.inputValue).toBe("secret prompt text");
    expect(out?.attributes).not.toHaveProperty("user_prompt"); // stripped from the bag
    expect(out?.attributes).toEqual({ "span.type": "interaction" });
  });

  it("test_parse_claude_tool_maps_name_input_output_from_event", () => {
    // M34: a `claude_code.tool` span → toolName (classifies as a tool), inputValue
    // from full_command, outputValue from the `tool.output` event's `output` key.
    const toolSpan = {
      ...rawSpan,
      name: "claude_code.tool",
      attributes: [
        { key: "tool_name", value: { stringValue: "Bash" } },
        { key: "full_command", value: { stringValue: "echo x" } },
      ],
      events: [
        {
          name: "tool.output",
          timeUnixNano: "1700000000050000000",
          attributes: [
            { key: "output", value: { stringValue: "x\n" } },
            { key: "bash_command", value: { stringValue: "echo x" } },
          ],
        },
      ],
    };
    const span = parseResourceSpans(envelopeWithService("claude-code", [toolSpan]))[0];
    expect(span?.toolName).toBe("Bash");
    expect(span?.inputValue).toBe("echo x");
    expect(span?.outputValue).toBe("x\n");
    // move-not-copy: the uncapped tool input is stripped from the persisted bag.
    expect(span?.attributes).not.toHaveProperty("full_command");
  });

  it("test_parse_claude_tool_strips_file_path_from_bag_when_mapped", () => {
    // M34/PII: a Read/Write/Edit tool's `file_path` → inputValue; the uncapped
    // source key must NOT remain in the persisted attributes bag (move-not-copy).
    const toolSpan = {
      ...rawSpan,
      name: "claude_code.tool",
      attributes: [
        { key: "tool_name", value: { stringValue: "Read" } },
        { key: "file_path", value: { stringValue: "/secret/path" } },
      ],
    };
    const span = parseResourceSpans(envelopeWithService("claude-code", [toolSpan]))[0];
    expect(span?.inputValue).toBe("/secret/path");
    expect(span?.attributes).not.toHaveProperty("file_path");
  });

  it("test_parse_claude_llm_ttft_and_cache", () => {
    // M34: TTFT + prompt-cache token counts (OTLP intValue → string → coerced int).
    const llmSpan = {
      ...rawSpan,
      name: "claude_code.llm_request",
      attributes: [
        { key: "ttft_ms", value: { intValue: "10741" } },
        { key: "cache_read_tokens", value: { intValue: "14503" } },
        { key: "cache_creation_tokens", value: { intValue: "671522" } },
      ],
    };
    const span = parseResourceSpans(envelopeWithService("claude-code", [llmSpan]))[0];
    expect(span?.ttftMs).toBe(10741);
    expect(span?.cacheReadTokens).toBe(14503);
    expect(span?.cacheCreationTokens).toBe(671522);
  });

  it("test_parse_uses_default_adapter_for_generic_service", () => {
    // a generic gen_ai producer: bare input_tokens must NOT be read (default only
    // reads gen_ai.usage.*) — proves the claude mapping does not leak to others.
    const genericSpan = {
      ...rawSpan,
      attributes: [
        { key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
        { key: "gen_ai.usage.input_tokens", value: { intValue: "100" } },
        { key: "input_tokens", value: { intValue: "999" } },
      ],
    };
    const span = parseResourceSpans(envelopeWithService("my-app", [genericSpan]))[0];
    expect(span?.model).toBe("gpt-4o");
    expect(span?.inputTokens).toBe(100); // gen_ai.usage, NOT the bare 999
  });

  it("test_parse_no_resource_attributes_uses_default", () => {
    // no resource attrs at all → default adapter, no throw (backward compat).
    const span = parseResourceSpans(envelope([rawSpan]))[0];
    expect(span?.spanId).toBe("a1");
  });

  it("test_parse_extracts_eval_attributes_and_strips_them", () => {
    // M26: `eval.<name>.*` attributes → typed span.evaluations; matched keys removed
    // from the persisted attributes bag (move-not-copy).
    const span = parseResourceSpans(
      envelope([
        {
          ...rawSpan,
          attributes: [
            { key: "eval.hallucination.score", value: { doubleValue: 0.2 } },
            { key: "eval.hallucination.label", value: { stringValue: "factual" } },
            { key: "other.attr", value: { stringValue: "keep" } },
          ],
        },
      ]),
    )[0];
    expect(span?.evaluations).toEqual([
      { name: "hallucination", score: 0.2, label: "factual" },
    ]);
    expect(span?.attributes).toEqual({ "other.attr": "keep" });
  });
});
