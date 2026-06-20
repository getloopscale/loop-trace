import { describe, it, expect } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { spanSchema, extractGenAi } from "@usetheo/lens-core";
// Test-only coupling: the contract test verifies the SDK's output is accepted by
// the REAL M1 receiver, so it imports the actual parser (not a hand-rolled stand-in).
// Production SDK code stays decoupled from the server packages.
import { parseResourceSpans } from "@usetheo/lens-api";

import { initTheoLens } from "./sdk.js";
import { startAgent } from "./agent-span.js";
import { collectingExporter } from "./__fixtures__/collecting-exporter.js";

const hr = (t: readonly [number, number]) =>
  String(BigInt(t[0]) * 1_000_000_000n + BigInt(t[1]));

/** Map a captured OTel ReadableSpan to the M1 domain-span candidate shape. */
function toM1Candidate(s: ReadableSpan): Record<string, unknown> {
  const ctx = s.spanContext();
  return {
    spanId: ctx.spanId,
    traceId: ctx.traceId,
    name: s.name,
    startTimeUnixNano: hr(s.startTime),
    endTimeUnixNano: hr(s.endTime),
    attributes: s.attributes as Record<string, unknown>,
  };
}

/** Encode a JS attribute value to the OTLP/JSON `AnyValue` wire wrapper. */
function toAnyValue(value: unknown): unknown {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    // proto-JSON encodes int64 as a STRING — the exact path the receiver flattens.
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  return { stringValue: String(value) };
}

/** Build the real OTLP/JSON envelope the M1 receiver consumes from a captured span. */
function toOtlpEnvelope(s: ReadableSpan): unknown {
  const ctx = s.spanContext();
  return {
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: ctx.traceId,
                spanId: ctx.spanId,
                name: s.name,
                startTimeUnixNano: hr(s.startTime),
                endTimeUnixNano: hr(s.endTime),
                attributes: Object.entries(s.attributes).map(([key, value]) => ({
                  key,
                  value: toAnyValue(value),
                })),
              },
            ],
          },
        ],
      },
    ],
  };
}

async function captureAgentSpan(): Promise<ReadableSpan> {
  const { exporter, spans } = collectingExporter();
  const theo = initTheoLens({ endpoint: "http://x", serviceName: "t", exporter });
  await startAgent(theo.tracer, "agent", async (span) => {
    span.setModel("gpt-4o").setProvider("openai").setUsage({ inputTokens: 12, outputTokens: 4 });
  });
  await theo.shutdown();
  return spans.find((x) => x.name === "agent")!;
}

describe("M1 ingestion contract", () => {
  it("sdk_span_validates_against_m1_spanSchema", async () => {
    const span = await captureAgentSpan();
    expect(spanSchema.safeParse(toM1Candidate(span)).success).toBe(true);
  });

  it("sdk_span_extractGenAi_populates_typed_columns", async () => {
    const span = await captureAgentSpan();
    expect(extractGenAi(span.attributes as Record<string, unknown>)).toEqual({
      model: "gpt-4o",
      provider: "openai",
      inputTokens: 12,
      outputTokens: 4,
    });
  });

  it("sdk_span_survives_the_real_otlp_wire_path_through_the_m1_receiver", async () => {
    // Encode to the OTLP/JSON wire shape (int64 tokens as STRINGS) and run through
    // the ACTUAL M1 parser — proves the SDK's spans ingest with numeric typed
    // columns even without Docker (closes review F-wx-1 / F-otel-7).
    const span = await captureAgentSpan();
    const parsed = parseResourceSpans(toOtlpEnvelope(span));
    expect(parsed).toHaveLength(1);
    const domain = parsed[0]!;
    expect(domain.model).toBe("gpt-4o");
    expect(domain.provider).toBe("openai");
    expect(domain.inputTokens).toBe(12); // number, decoded from intValue "12"
    expect(domain.outputTokens).toBe(4);
    expect(domain.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(domain.traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});
