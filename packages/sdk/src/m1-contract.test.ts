import { describe, it, expect } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { spanSchema, extractGenAi } from "@usetheo/lens-core";

import { initTheoLens } from "./sdk.js";
import { startAgent } from "./agent-span.js";
import { collectingExporter } from "./__fixtures__/collecting-exporter.js";

/** Map a captured OTel ReadableSpan to the M1 domain-span candidate shape. */
function toM1Candidate(s: ReadableSpan): Record<string, unknown> {
  const ctx = s.spanContext();
  const hr = (t: readonly [number, number]) =>
    String(BigInt(t[0]) * 1_000_000_000n + BigInt(t[1]));
  return {
    spanId: ctx.spanId,
    traceId: ctx.traceId,
    name: s.name,
    startTimeUnixNano: hr(s.startTime),
    endTimeUnixNano: hr(s.endTime),
    attributes: s.attributes as Record<string, unknown>,
  };
}

describe("M1 ingestion contract", () => {
  it("sdk_span_validates_against_m1_spanSchema_and_extractGenAi_populates_columns", async () => {
    const { exporter, spans } = collectingExporter();
    const theo = initTheoLens({ endpoint: "http://x", serviceName: "t", exporter });
    await startAgent(theo.tracer, "agent", async (span) => {
      span.setModel("gpt-4o").setProvider("openai").setUsage({ inputTokens: 12, outputTokens: 4 });
    });
    await theo.shutdown();

    const span = spans.find((x) => x.name === "agent")!;
    const candidate = toM1Candidate(span);

    // 1. The SDK span validates against the M1 domain schema.
    expect(spanSchema.safeParse(candidate).success).toBe(true);

    // 2. M1's extractGenAi populates the typed columns from the SDK's attributes (EC-2).
    const genai = extractGenAi(span.attributes as Record<string, unknown>);
    expect(genai).toEqual({
      model: "gpt-4o",
      provider: "openai",
      inputTokens: 12,
      outputTokens: 4,
    });
  });
});
