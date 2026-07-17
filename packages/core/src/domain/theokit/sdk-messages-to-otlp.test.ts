import { describe, it, expect } from "vitest";
import { sdkMessagesToOtlp, THEOKIT_SERVICE_NAME } from "./sdk-messages-to-otlp.js";
import type { RunResult, SDKMessage } from "./sdk-message.js";

/**
 * Shared test vectors — the SAME behaviors asserted on the SDK copy
 * (`packages/sdk/src/ingest/theokit.test.ts`). Keeping both green guards the ADR-1 duplication
 * (SDK-standalone forces two copies) from drifting.
 */
const T0 = 1_700_000_000_000;
const opts = { startTimeMs: T0 };
function flat(otlp: ReturnType<typeof sdkMessagesToOtlp>) {
  const rs = otlp.resourceSpans[0];
  const resourceAttrs = Object.fromEntries(rs.resource.attributes.map((a) => [a.key, "stringValue" in a.value ? a.value.stringValue : a.value.intValue]));
  const spans = rs.scopeSpans[0].spans;
  const attrsOf = (s: (typeof spans)[number]) => Object.fromEntries(s.attributes.map((a) => [a.key, "stringValue" in a.value ? a.value.stringValue : a.value.intValue]));
  return { resourceAttrs, spans, root: spans[0], attrsOf };
}
const sys = (run: string, model?: string): SDKMessage => ({ type: "system", subtype: "init", agent_id: "a", run_id: run, ...(model ? { model } : {}) });

describe("core sdkMessagesToOtlp (M116 shared vectors)", () => {
  it("test_run_id_becomes_trace_id", () => {
    expect(flat(sdkMessagesToOtlp([sys("run-9", "gpt-4o")], undefined, opts)).spans.every((s) => s.traceId === "run-9")).toBe(true);
  });
  it("test_emitted_resource_has_service_name_theokit_sdk", () => {
    expect(flat(sdkMessagesToOtlp([sys("r")], undefined, opts)).resourceAttrs["service.name"]).toBe(THEOKIT_SERVICE_NAME);
  });
  it("test_system_init_model_as_model_selection_extracts_id", () => {
    const m: SDKMessage = { type: "system", subtype: "init", agent_id: "a", run_id: "r", model: { id: "claude-opus-4-8" } };
    expect(flat(sdkMessagesToOtlp([m], undefined, opts)).attrsOf(flat(sdkMessagesToOtlp([m], undefined, opts)).root)["gen_ai.request.model"]).toBe("claude-opus-4-8");
  });
  it("test_runresult_usage_maps_tokens_never_fabricated", () => {
    const rr: RunResult = { usage: { inputTokens: 100, outputTokens: 20 } };
    const withRr = flat(sdkMessagesToOtlp([sys("r")], rr, opts));
    expect(withRr.attrsOf(withRr.root)["gen_ai.usage.input_tokens"]).toBe("100");
    const noRr = flat(sdkMessagesToOtlp([sys("r")], undefined, opts));
    expect(noRr.attrsOf(noRr.root)["gen_ai.usage.input_tokens"]).toBeUndefined();
  });
  it("test_tool_call_completed_becomes_tool_span_running_skipped", () => {
    const done: SDKMessage = { type: "tool_call", agent_id: "a", run_id: "r", call_id: "c1", name: "Bash", status: "completed", args: { cmd: "ls" }, result: "f.txt" };
    const running: SDKMessage = { type: "tool_call", agent_id: "a", run_id: "r", call_id: "c2", name: "Read", status: "running" };
    const { spans } = flat(sdkMessagesToOtlp([sys("r"), done, running], undefined, opts));
    expect(spans.find((s) => s.name === "Bash")).toBeTruthy();
    expect(spans.find((s) => s.name === "Read")).toBeUndefined();
  });
  it("test_object_delta_request_task_no_throw", () => {
    const msgs: SDKMessage[] = [sys("r"), { type: "object_delta", agent_id: "a", run_id: "r", partial: {}, attempt: 1 }, { type: "request", agent_id: "a", run_id: "r", request_id: "q" }, { type: "task", agent_id: "a", run_id: "r" }];
    expect(() => sdkMessagesToOtlp(msgs, undefined, opts)).not.toThrow();
  });
});
