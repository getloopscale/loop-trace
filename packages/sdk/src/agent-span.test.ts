import { describe, it, expect } from "vitest";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { SpanStatusCode } from "@opentelemetry/api";

import { trace, context } from "@opentelemetry/api";

import { initLoopTrace } from "./sdk.js";
import { startAgent, recordToolCall } from "./agent-span.js";
import {
  collectingExporter,
  failingExporter,
  throwingExporter,
} from "./__fixtures__/collecting-exporter.js";

function parentSpanIdOf(s: ReadableSpan): string | undefined {
  return (
    (s as { parentSpanContext?: { spanId?: string } }).parentSpanContext?.spanId ??
    (s as { parentSpanId?: string }).parentSpanId
  );
}

describe("startAgent / recordToolCall", () => {
  it("startAgent_emits_gen_ai_span_with_model_provider_usage", async () => {
    const { exporter, spans } = collectingExporter();
    const looptrace = initLoopTrace({ endpoint: "http://x", serviceName: "t", exporter });
    await startAgent(looptrace.tracer, "agent", async (span) => {
      span.setModel("gpt-4o").setProvider("openai").setUsage({ inputTokens: 10, outputTokens: 5 });
    });
    await looptrace.shutdown();
    const s = spans.find((x) => x.name === "agent");
    expect(s?.attributes["gen_ai.request.model"]).toBe("gpt-4o");
    expect(s?.attributes["gen_ai.system"]).toBe("openai");
    expect(s?.attributes["gen_ai.usage.input_tokens"]).toBe(10);
    expect(s?.attributes["gen_ai.usage.output_tokens"]).toBe(5);
  });

  it("test_set_input_emits_input_value_attribute", async () => {
    const { exporter, spans } = collectingExporter();
    const looptrace = initLoopTrace({ endpoint: "http://x", serviceName: "t", exporter });
    await startAgent(looptrace.tracer, "agent", async (span) => {
      span.setInput("hi");
    });
    await looptrace.shutdown();
    const s = spans.find((x) => x.name === "agent");
    expect(s?.attributes["input.value"]).toBe("hi");
  });

  it("test_set_output_emits_output_value_attribute", async () => {
    const { exporter, spans } = collectingExporter();
    const looptrace = initLoopTrace({ endpoint: "http://x", serviceName: "t", exporter });
    await startAgent(looptrace.tracer, "agent", async (span) => {
      span.setOutput("ok");
    });
    await looptrace.shutdown();
    const s = spans.find((x) => x.name === "agent");
    expect(s?.attributes["output.value"]).toBe("ok");
  });

  it("test_input_output_setters_chain", async () => {
    const { exporter, spans } = collectingExporter();
    const looptrace = initLoopTrace({ endpoint: "http://x", serviceName: "t", exporter });
    await startAgent(looptrace.tracer, "agent", async (span) => {
      span.setInput("q").setOutput("a").setModel("gpt-4o");
    });
    await looptrace.shutdown();
    const s = spans.find((x) => x.name === "agent");
    expect(s?.attributes["input.value"]).toBe("q");
    expect(s?.attributes["output.value"]).toBe("a");
    expect(s?.attributes["gen_ai.request.model"]).toBe("gpt-4o");
  });

  it("setResponseModel_emits_gen_ai_response_model", async () => {
    const { exporter, spans } = collectingExporter();
    const looptrace = initLoopTrace({ endpoint: "http://x", serviceName: "t", exporter });
    await startAgent(looptrace.tracer, "agent", async (span) => {
      span.setResponseModel("gpt-4o-2024-08-06");
    });
    await looptrace.shutdown();
    const s = spans.find((x) => x.name === "agent");
    expect(s?.attributes["gen_ai.response.model"]).toBe("gpt-4o-2024-08-06");
  });

  it("startAgent_records_exception_and_sets_error_status_on_throw", async () => {
    const { exporter, spans } = collectingExporter();
    const looptrace = initLoopTrace({ endpoint: "http://x", serviceName: "t", exporter });
    await expect(
      startAgent(looptrace.tracer, "agent", async () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow("kaboom");
    await looptrace.shutdown();
    const s = spans.find((x) => x.name === "agent");
    expect(s?.status.code).toBe(SpanStatusCode.ERROR);
    expect(s?.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("recordToolCall_emits_child_execute_tool_span_nested_under_agent", async () => {
    const { exporter, spans } = collectingExporter();
    const looptrace = initLoopTrace({ endpoint: "http://x", serviceName: "t", exporter });
    await startAgent(looptrace.tracer, "agent", async (span) => {
      recordToolCall(span, "search", { q: "shoes" });
    });
    await looptrace.shutdown();
    const agent = spans.find((x) => x.name === "agent")!;
    const tool = spans.find((x) => x.name === "search")!;
    expect(tool.attributes["gen_ai.operation.name"]).toBe("execute_tool");
    expect(parentSpanIdOf(tool)).toBe(agent.spanContext().spanId);
  });

  it("recordToolCall_does_not_throw_on_non_serializable_args", async () => {
    // safeJson guards circular refs / BigInt so a bad args object can never crash
    // the instrumented app — the attribute degrades to a string (T1.2 edge case).
    const { exporter, spans } = collectingExporter();
    const looptrace = initLoopTrace({ endpoint: "http://x", serviceName: "t", exporter });
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    await startAgent(looptrace.tracer, "agent", async (span) => {
      expect(() => recordToolCall(span, "search", circular)).not.toThrow();
    });
    await looptrace.shutdown();
    const tool = spans.find((x) => x.name === "search");
    expect(typeof tool?.attributes["gen_ai.tool.arguments"]).toBe("string");
  });

  it("export_failure_does_not_throw_into_agent_fn", async () => {
    const looptrace = initLoopTrace({ endpoint: "http://x", serviceName: "t", exporter: failingExporter() });
    const result = await startAgent(looptrace.tracer, "agent", async () => "ok");
    expect(result).toBe("ok");
    await looptrace.shutdown();
  });

  it("synchronous_exporter_throw_is_isolated_from_agent_fn_and_shutdown", async () => {
    // Harshest fail-open adversary: export() THROWS synchronously. The agent fn
    // must still complete (export runs only at flush, never during fn) AND
    // shutdown must swallow the throw and resolve (EC-2 / Failure-scenarios row 1).
    const looptrace = initLoopTrace({ endpoint: "http://x", serviceName: "t", exporter: throwingExporter() });
    const result = await startAgent(looptrace.tracer, "agent", async () => "ok");
    expect(result).toBe("ok");
    await expect(looptrace.shutdown()).resolves.toBeUndefined();
  });

  it("bare_startSpan_inside_agent_fn_does_not_auto_nest_M2_contract", async () => {
    // Pins the documented M2 limitation: without provider.register() there is no
    // global context manager, so a span NOT created via the SDK helpers does not
    // auto-nest under the agent. Flipping this is a deliberate later-milestone change.
    const { exporter, spans } = collectingExporter();
    const looptrace = initLoopTrace({ endpoint: "http://x", serviceName: "t", exporter });
    await startAgent(looptrace.tracer, "agent", async () => {
      // Bare OTel span, no explicit context — relies on ambient context (noop in M2).
      looptrace.tracer.startSpan("bare").end();
      expect(trace.getSpan(context.active())).toBeUndefined();
    });
    await looptrace.shutdown();
    const agent = spans.find((x) => x.name === "agent")!;
    const bare = spans.find((x) => x.name === "bare")!;
    expect(parentSpanIdOf(bare)).not.toBe(agent.spanContext().spanId);
  });
});
