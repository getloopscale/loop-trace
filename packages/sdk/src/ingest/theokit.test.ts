import { describe, it, expect } from "vitest";
import { sdkMessagesToOtlp, THEOKIT_SERVICE_NAME } from "./theokit.js";
import type { RunResult, SDKMessage } from "./sdk-message.js";

const T0 = 1_700_000_000_000; // fixed base for deterministic timestamps
const opts = { startTimeMs: T0 };

/** Flatten the single resource + its spans for assertions. */
function flat(otlp: ReturnType<typeof sdkMessagesToOtlp>) {
  const rs = otlp.resourceSpans[0];
  const resourceAttrs = Object.fromEntries(rs.resource.attributes.map((a) => [a.key, "stringValue" in a.value ? a.value.stringValue : a.value.intValue]));
  const spans = rs.scopeSpans[0].spans;
  const attrsOf = (s: (typeof spans)[number]) =>
    Object.fromEntries(s.attributes.map((a) => [a.key, "stringValue" in a.value ? a.value.stringValue : a.value.intValue]));
  return { resourceAttrs, spans, root: spans[0], attrsOf };
}

const sys = (run: string, model?: string, tools?: string[]): SDKMessage => ({ type: "system", subtype: "init", agent_id: "agentA", run_id: run, ...(model ? { model } : {}), ...(tools ? { tools } : {}) });
const user = (run: string, text: string): SDKMessage => ({ type: "user", agent_id: "agentA", run_id: run, message: { role: "user", content: [{ type: "text", text }] } });
const asst = (run: string, text: string): SDKMessage => ({ type: "assistant", agent_id: "agentA", run_id: run, message: { role: "assistant", content: [{ type: "text", text }] } });

describe("sdkMessagesToOtlp (M115 mapper)", () => {
  it("test_run_id_becomes_trace_id", () => {
    const { spans } = flat(sdkMessagesToOtlp([sys("run-42", "gpt-4o")], undefined, opts));
    expect(spans.every((s) => s.traceId === "run-42")).toBe(true);
  });

  it("test_emitted_resource_has_service_name_theokit_sdk", () => {
    const { resourceAttrs } = flat(sdkMessagesToOtlp([sys("r")], undefined, opts));
    expect(resourceAttrs["service.name"]).toBe(THEOKIT_SERVICE_NAME);
  });

  it("test_system_init_sets_root_model_and_tools", () => {
    const { root, attrsOf } = flat(sdkMessagesToOtlp([sys("r", "claude-opus-4-8", ["Bash", "Read"])], undefined, opts));
    const a = attrsOf(root);
    expect(a["gen_ai.request.model"]).toBe("claude-opus-4-8");
    expect(a["theokit.tools"]).toBe("Bash,Read");
    expect(a["agent.id"]).toBe("agentA");
  });

  it("test_user_message_maps_to_input_value", () => {
    const { root, attrsOf } = flat(sdkMessagesToOtlp([sys("r"), user("r", "What is 2+2?")], undefined, opts));
    expect(attrsOf(root)["input.value"]).toBe("What is 2+2?");
  });

  it("test_assistant_text_maps_to_output_value", () => {
    const { root, attrsOf } = flat(sdkMessagesToOtlp([sys("r"), asst("r", "4")], undefined, opts));
    expect(attrsOf(root)["output.value"]).toBe("4");
  });

  it("test_assistant_tool_use_block_becomes_tool_span", () => {
    const m: SDKMessage = { type: "assistant", agent_id: "a", run_id: "r", message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "search", input: { q: "cats" } }] } };
    const { spans, attrsOf } = flat(sdkMessagesToOtlp([sys("r"), m], undefined, opts));
    const tool = spans.find((s) => s.name === "search");
    expect(tool?.parentSpanId).toBe(spans[0].spanId);
    expect(attrsOf(tool!)["gen_ai.tool.name"]).toBe("search");
    expect(attrsOf(tool!)["input.value"]).toBe(JSON.stringify({ q: "cats" }));
  });

  it("test_tool_call_maps_name_args_result_status", () => {
    const tc: SDKMessage = { type: "tool_call", agent_id: "a", run_id: "r", call_id: "c1", name: "Bash", status: "completed", args: { cmd: "ls" }, result: "file.txt" };
    const { spans, attrsOf } = flat(sdkMessagesToOtlp([sys("r"), tc], undefined, opts));
    const tool = spans.find((s) => s.name === "Bash")!;
    expect(attrsOf(tool)["gen_ai.tool.name"]).toBe("Bash");
    expect(attrsOf(tool)["input.value"]).toBe(JSON.stringify({ cmd: "ls" }));
    expect(tool.events?.[0]?.name).toBe("tool.output");
    expect(tool.events?.[0]?.attributes?.find((a) => a.key === "output")).toBeTruthy();
  });

  it("test_tool_call_error_sets_span_error_status", () => {
    const tc: SDKMessage = { type: "tool_call", agent_id: "a", run_id: "r", call_id: "c1", name: "Bash", status: "error", result: "boom" };
    const { spans } = flat(sdkMessagesToOtlp([sys("r"), tc], undefined, opts));
    expect(spans.find((s) => s.name === "Bash")?.status?.code).toBe("STATUS_CODE_ERROR");
  });

  it("test_thinking_maps_duration", () => {
    const th: SDKMessage = { type: "thinking", agent_id: "a", run_id: "r", text: "let me think", thinking_duration_ms: 250 };
    const { spans, attrsOf } = flat(sdkMessagesToOtlp([sys("r"), th], undefined, opts));
    const t = spans.find((s) => s.name === "thinking")!;
    expect(attrsOf(t)["theokit.thinking.duration_ms"]).toBe("250");
    expect(attrsOf(t)["output.value"]).toBe("let me think");
  });

  it("test_status_error_sets_trace_error", () => {
    const st: SDKMessage = { type: "status", agent_id: "a", run_id: "r", status: "ERROR", message: "failed" };
    const { root } = flat(sdkMessagesToOtlp([sys("r"), st], undefined, opts));
    expect(root.status?.code).toBe("STATUS_CODE_ERROR");
  });

  it("test_runresult_usage_maps_tokens_and_cache", () => {
    const rr: RunResult = { usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 3 } };
    const { root, attrsOf } = flat(sdkMessagesToOtlp([sys("r")], rr, opts));
    const a = attrsOf(root);
    expect(a["gen_ai.usage.input_tokens"]).toBe("100");
    expect(a["gen_ai.usage.output_tokens"]).toBe("20");
    expect(a["gen_ai.usage.cache_read_input_tokens"]).toBe("5");
    expect(a["gen_ai.usage.cache_creation_input_tokens"]).toBe("3");
  });

  it("test_runresult_cost_is_advisory_attribute", () => {
    const { root, attrsOf } = flat(sdkMessagesToOtlp([sys("r")], { cost: { totalUsd: 0.0042 } }, opts));
    expect(attrsOf(root)["theokit.cost.usd"]).toBe("0.0042");
  });

  it("test_aborted_stream_without_runresult_degrades_no_tokens", () => {
    const { root, attrsOf } = flat(sdkMessagesToOtlp([sys("r"), user("r", "hi")], undefined, opts));
    const a = attrsOf(root);
    expect(a["gen_ai.usage.input_tokens"]).toBeUndefined(); // never fabricated
    expect(a["gen_ai.usage.output_tokens"]).toBeUndefined();
  });

  it("test_object_delta_request_task_are_handled_no_throw", () => {
    const msgs: SDKMessage[] = [
      sys("r"),
      { type: "object_delta", agent_id: "a", run_id: "r", partial: { x: 1 }, attempt: 1 },
      { type: "request", agent_id: "a", run_id: "r", request_id: "q1" },
      { type: "task", agent_id: "a", run_id: "r", status: "working", text: "milestone" },
    ];
    expect(() => sdkMessagesToOtlp(msgs, undefined, opts)).not.toThrow();
  });

  it("test_unstable_tool_args_are_capped_and_circular_degrades", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const tc: SDKMessage = { type: "tool_call", agent_id: "a", run_id: "r", call_id: "c", name: "X", status: "completed", args: circular, result: "x".repeat(20000) };
    const { spans, attrsOf } = flat(sdkMessagesToOtlp([sys("r"), tc], undefined, opts));
    const tool = spans.find((s) => s.name === "X")!;
    expect(attrsOf(tool)["input.value"]).toBeUndefined(); // circular → degrade, no throw
    const out = tool.events?.[0]?.attributes?.find((a) => a.key === "output");
    const outVal = out && "stringValue" in out.value ? out.value.stringValue : "";
    expect(outVal.length).toBe(8192); // capped
  });

  it("test_timestamps_are_valid_ns_and_not_future", () => {
    const { spans } = flat(sdkMessagesToOtlp([sys("r")], undefined)); // default clock (~1s ago)
    for (const s of spans) {
      expect(s.startTimeUnixNano).toMatch(/^\d+$/);
      expect(Number(s.startTimeUnixNano)).toBeLessThan(Date.now() * 1e6);
    }
  });
});
