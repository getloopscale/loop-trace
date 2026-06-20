import { describe, it, expect } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { SpanStatusCode } from "@opentelemetry/api";

import { initTheoLens } from "./sdk.js";
import { startAgent, recordToolCall } from "./agent-span.js";
import { collectingExporter, failingExporter } from "./__fixtures__/collecting-exporter.js";

function parentSpanIdOf(s: ReadableSpan): string | undefined {
  return (
    (s as { parentSpanContext?: { spanId?: string } }).parentSpanContext?.spanId ??
    (s as { parentSpanId?: string }).parentSpanId
  );
}

describe("startAgent / recordToolCall", () => {
  it("startAgent_emits_gen_ai_span_with_model_provider_usage", async () => {
    const { exporter, spans } = collectingExporter();
    const theo = initTheoLens({ endpoint: "http://x", serviceName: "t", exporter });
    await startAgent(theo.tracer, "agent", async (span) => {
      span.setModel("gpt-4o").setProvider("openai").setUsage({ inputTokens: 10, outputTokens: 5 });
    });
    await theo.shutdown();
    const s = spans.find((x) => x.name === "agent");
    expect(s?.attributes["gen_ai.request.model"]).toBe("gpt-4o");
    expect(s?.attributes["gen_ai.system"]).toBe("openai");
    expect(s?.attributes["gen_ai.usage.input_tokens"]).toBe(10);
    expect(s?.attributes["gen_ai.usage.output_tokens"]).toBe(5);
  });

  it("startAgent_records_exception_and_sets_error_status_on_throw", async () => {
    const { exporter, spans } = collectingExporter();
    const theo = initTheoLens({ endpoint: "http://x", serviceName: "t", exporter });
    await expect(
      startAgent(theo.tracer, "agent", async () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow("kaboom");
    await theo.shutdown();
    const s = spans.find((x) => x.name === "agent");
    expect(s?.status.code).toBe(SpanStatusCode.ERROR);
    expect(s?.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("recordToolCall_emits_child_execute_tool_span_nested_under_agent", async () => {
    const { exporter, spans } = collectingExporter();
    const theo = initTheoLens({ endpoint: "http://x", serviceName: "t", exporter });
    await startAgent(theo.tracer, "agent", async (span) => {
      recordToolCall(span, "search", { q: "shoes" });
    });
    await theo.shutdown();
    const agent = spans.find((x) => x.name === "agent")!;
    const tool = spans.find((x) => x.name === "search")!;
    expect(tool.attributes["gen_ai.operation.name"]).toBe("execute_tool");
    expect(parentSpanIdOf(tool)).toBe(agent.spanContext().spanId);
  });

  it("export_failure_does_not_throw_into_agent_fn", async () => {
    const theo = initTheoLens({ endpoint: "http://x", serviceName: "t", exporter: failingExporter() });
    const result = await startAgent(theo.tracer, "agent", async () => "ok");
    expect(result).toBe("ok");
    await theo.shutdown();
  });
});
