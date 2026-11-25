/**
 * M119 (D1) — the SINGLE source of truth for the SDKMessage→OTLP mapper's documented behaviors.
 *
 * The mapper is DUPLICATED by the codebase's own ADR-1 (`@looptrace/sdk` stays standalone, so it
 * carries its own copy at `packages/sdk/src/ingest/theokit.ts`, and the core copy at
 * `sdk-messages-to-otlp.ts` powers the native `POST /v1/runs`). A duplicated implementation is only
 * safe with a shared guard. This fixture encodes each named behavior as `{ name, input, assert }` and
 * is imported by BOTH mapper test files (`sdk/.../theokit.test.ts` and `core/.../sdk-messages-to-otlp.test.ts`)
 * so the 18 documented behaviors are pinned identically on both copies — adding a behavior edits ONE
 * file and both copies re-pin. The core test additionally asserts `coreMapper(input) ≡ sdkMapper(input)`
 * per DETERMINISTIC vector (belt-and-suspenders — the equality proves the copies agree, the assertions
 * prove either is correct; both are needed, per blueprint D1).
 *
 * This file is TEST-only support — it exports data + assertions, no runtime mapper logic. It lives in
 * core (imported by the SDK test via `@looptrace/core`, mirroring how the SDK contract tests already
 * import from core) but never imports a mapper, so it stays copy-agnostic.
 *
 * @public
 */
import { expect } from "vitest";
import type { RunResult, SDKMessage } from "./sdk-message.js";

/** The structural OTLP envelope shape BOTH mapper copies return (structurally identical types). */
interface OtlpValueLike {
  stringValue?: string;
  intValue?: string;
}
interface OtlpAttrLike {
  key: string;
  value: OtlpValueLike;
}
interface OtlpSpanLike {
  spanId: string;
  traceId: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  parentSpanId?: string;
  attributes: OtlpAttrLike[];
  events?: { name: string; timeUnixNano: string; attributes?: OtlpAttrLike[] }[];
  status?: { code: string };
}
export interface OtlpTracesLike {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttrLike[] };
    scopeSpans: Array<{ spans: OtlpSpanLike[] }>;
  }>;
}

/** A mapper (either copy) — used by the shared cross-copy equality loop. */
export type SdkMapper = (
  messages: readonly SDKMessage[],
  runResult?: RunResult,
  opts?: { startTimeMs?: number },
) => OtlpTracesLike;

/** Flatten the single resource + its spans into an assertion-friendly view (shared by both test files). */
export function flattenOtlp(otlp: OtlpTracesLike) {
  const rs = otlp.resourceSpans[0]!;
  const attrMap = (attrs: OtlpAttrLike[]): Record<string, string | undefined> =>
    Object.fromEntries(attrs.map((a) => [a.key, "stringValue" in a.value ? a.value.stringValue : a.value.intValue]));
  const resourceAttrs = attrMap(rs.resource.attributes);
  const spans = rs.scopeSpans[0]!.spans;
  return { resourceAttrs, spans, root: spans[0]!, attrsOf: (s: OtlpSpanLike) => attrMap(s.attributes) };
}

/** The stable base timestamp for the deterministic vectors. */
export const T0 = 1_700_000_000_000;

/** service.name that selects the `theokit-sdk` engine adapter (mirrors THEOKIT_SERVICE_NAME). */
const THEOKIT_SERVICE_NAME = "theokit-sdk";

const sys = (run: string, model?: string | { id: string; params?: unknown[] }, tools?: string[]): SDKMessage => ({
  type: "system",
  subtype: "init",
  agent_id: "agentA",
  run_id: run,
  ...(model ? { model } : {}),
  ...(tools ? { tools } : {}),
});
const user = (run: string, text: string): SDKMessage => ({ type: "user", agent_id: "agentA", run_id: run, message: { role: "user", content: [{ type: "text", text }] } });
const asst = (run: string, text: string): SDKMessage => ({ type: "assistant", agent_id: "agentA", run_id: run, message: { role: "assistant", content: [{ type: "text", text }] } });

type Flat = ReturnType<typeof flattenOtlp>;

export interface MapperVector {
  /** Behavior name (matches the historical `it(...)` case name). */
  readonly name: string;
  readonly input: {
    readonly messages: readonly SDKMessage[];
    readonly result?: RunResult;
    /** When omitted, the vector is NON-deterministic (default clock) and is EXCLUDED from the cross-copy equality loop. */
    readonly opts?: { startTimeMs?: number };
  };
  /** Deterministic vectors (fixed startTimeMs) participate in the `coreMapper ≡ sdkMapper` equality loop. */
  readonly deterministic: boolean;
  /** Assert the documented behavior against a flattened OTLP produced by EITHER mapper copy. */
  readonly assert: (flat: Flat) => void;
}

const opts = { startTimeMs: T0 } as const;

/**
 * The 18 documented SDKMessage→OTLP behaviors (the SDK test's original 18 `it(...)` cases + the core
 * test's 6 subset). Each fed through BOTH mapper copies by the two test files.
 */
export const MAPPER_VECTORS: readonly MapperVector[] = [
  {
    name: "run_id_becomes_trace_id",
    input: { messages: [sys("run-42", "gpt-4o")], opts },
    deterministic: true,
    assert: (f) => expect(f.spans.every((s) => s.traceId === "run-42")).toBe(true),
  },
  {
    name: "emitted_resource_has_service_name_theokit_sdk",
    input: { messages: [sys("r")], opts },
    deterministic: true,
    assert: (f) => expect(f.resourceAttrs["service.name"]).toBe(THEOKIT_SERVICE_NAME),
  },
  {
    name: "system_init_sets_root_model_and_tools",
    input: { messages: [sys("r", "claude-opus-4-8", ["Bash", "Read"])], opts },
    deterministic: true,
    assert: (f) => {
      const a = f.attrsOf(f.root);
      expect(a["gen_ai.request.model"]).toBe("claude-opus-4-8");
      expect(a["theokit.tools"]).toBe("Bash,Read");
      expect(a["agent.id"]).toBe("agentA");
    },
  },
  {
    name: "system_init_model_as_model_selection_extracts_id",
    input: { messages: [{ type: "system", subtype: "init", agent_id: "a", run_id: "r", model: { id: "claude-opus-4-8", params: [{ p: 1 }] } }], opts },
    deterministic: true,
    // The @theokit/sdk wire shape: model is a ModelSelection {id, params}, not a string — extract .id,
    // never `[object Object]` (the v14 drift class).
    assert: (f) => expect(f.attrsOf(f.root)["gen_ai.request.model"]).toBe("claude-opus-4-8"),
  },
  {
    name: "tool_call_running_status_skipped_no_span",
    input: { messages: [sys("r"), { type: "tool_call", agent_id: "a", run_id: "r", call_id: "c1", name: "Bash", status: "running", args: { cmd: "ls" } }], opts },
    deterministic: true,
    assert: (f) => {
      // A `running` tool_call is a lifecycle-start, not a completed span — only the root exists.
      expect(f.spans.filter((s) => s.name === "Bash")).toHaveLength(0);
      expect(f.spans).toHaveLength(1);
    },
  },
  {
    name: "user_message_maps_to_input_value",
    input: { messages: [sys("r"), user("r", "What is 2+2?")], opts },
    deterministic: true,
    assert: (f) => expect(f.attrsOf(f.root)["input.value"]).toBe("What is 2+2?"),
  },
  {
    name: "assistant_text_maps_to_output_value",
    input: { messages: [sys("r"), asst("r", "4")], opts },
    deterministic: true,
    assert: (f) => expect(f.attrsOf(f.root)["output.value"]).toBe("4"),
  },
  {
    name: "assistant_tool_use_block_becomes_tool_span",
    input: { messages: [sys("r"), { type: "assistant", agent_id: "a", run_id: "r", message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "search", input: { q: "cats" } }] } }], opts },
    deterministic: true,
    assert: (f) => {
      const tool = f.spans.find((s) => s.name === "search")!;
      expect(tool.parentSpanId).toBe(f.spans[0]!.spanId);
      expect(f.attrsOf(tool)["gen_ai.tool.name"]).toBe("search");
      expect(f.attrsOf(tool)["input.value"]).toBe(JSON.stringify({ q: "cats" }));
    },
  },
  {
    name: "tool_call_maps_name_args_result_status",
    input: { messages: [sys("r"), { type: "tool_call", agent_id: "a", run_id: "r", call_id: "c1", name: "Bash", status: "completed", args: { cmd: "ls" }, result: "file.txt" }], opts },
    deterministic: true,
    assert: (f) => {
      const tool = f.spans.find((s) => s.name === "Bash")!;
      expect(f.attrsOf(tool)["gen_ai.tool.name"]).toBe("Bash");
      expect(f.attrsOf(tool)["input.value"]).toBe(JSON.stringify({ cmd: "ls" }));
      expect(tool.events?.[0]?.name).toBe("tool.output");
      expect(tool.events?.[0]?.attributes?.find((a) => a.key === "output")).toBeTruthy();
    },
  },
  {
    name: "tool_call_error_sets_span_error_status",
    input: { messages: [sys("r"), { type: "tool_call", agent_id: "a", run_id: "r", call_id: "c1", name: "Bash", status: "error", result: "boom" }], opts },
    deterministic: true,
    assert: (f) => expect(f.spans.find((s) => s.name === "Bash")?.status?.code).toBe("STATUS_CODE_ERROR"),
  },
  {
    name: "thinking_maps_duration",
    input: { messages: [sys("r"), { type: "thinking", agent_id: "a", run_id: "r", text: "let me think", thinking_duration_ms: 250 }], opts },
    deterministic: true,
    assert: (f) => {
      const t = f.spans.find((s) => s.name === "thinking")!;
      expect(f.attrsOf(t)["theokit.thinking.duration_ms"]).toBe("250");
      expect(f.attrsOf(t)["output.value"]).toBe("let me think");
    },
  },
  {
    name: "status_error_sets_trace_error",
    input: { messages: [sys("r"), { type: "status", agent_id: "a", run_id: "r", status: "ERROR", message: "failed" }], opts },
    deterministic: true,
    assert: (f) => expect(f.root.status?.code).toBe("STATUS_CODE_ERROR"),
  },
  {
    name: "runresult_usage_maps_tokens_and_cache",
    input: { messages: [sys("r")], result: { usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5, cacheCreationInputTokens: 3 } }, opts },
    deterministic: true,
    assert: (f) => {
      const a = f.attrsOf(f.root);
      expect(a["gen_ai.usage.input_tokens"]).toBe("100");
      expect(a["gen_ai.usage.output_tokens"]).toBe("20");
      expect(a["gen_ai.usage.cache_read_input_tokens"]).toBe("5");
      expect(a["gen_ai.usage.cache_creation_input_tokens"]).toBe("3");
    },
  },
  {
    name: "runresult_cost_is_advisory_attribute",
    input: { messages: [sys("r")], result: { cost: { totalUsd: 0.0042 } }, opts },
    deterministic: true,
    assert: (f) => expect(f.attrsOf(f.root)["theokit.cost.usd"]).toBe("0.0042"),
  },
  {
    name: "aborted_stream_without_runresult_degrades_no_tokens",
    input: { messages: [sys("r"), user("r", "hi")], opts },
    deterministic: true,
    assert: (f) => {
      const a = f.attrsOf(f.root);
      expect(a["gen_ai.usage.input_tokens"]).toBeUndefined(); // never fabricated
      expect(a["gen_ai.usage.output_tokens"]).toBeUndefined();
    },
  },
  {
    name: "object_delta_request_task_are_handled_no_throw",
    input: {
      messages: [
        sys("r"),
        { type: "object_delta", agent_id: "a", run_id: "r", partial: { x: 1 }, attempt: 1 },
        { type: "request", agent_id: "a", run_id: "r", request_id: "q1" },
        { type: "task", agent_id: "a", run_id: "r", status: "working", text: "milestone" },
      ],
      opts,
    },
    deterministic: true,
    // No-throw is proven by the mapper having produced a flat envelope at all; assert the root exists.
    assert: (f) => expect(f.root.traceId).toBe("r"),
  },
  {
    name: "unstable_tool_args_are_capped_and_circular_degrades",
    input: {
      messages: [
        sys("r"),
        { type: "tool_call", agent_id: "a", run_id: "r", call_id: "c", name: "X", status: "completed", args: buildCircular(), result: "x".repeat(20000) },
      ],
      opts,
    },
    deterministic: true,
    assert: (f) => {
      const tool = f.spans.find((s) => s.name === "X")!;
      expect(f.attrsOf(tool)["input.value"]).toBeUndefined(); // circular → degrade, no throw
      const out = tool.events?.[0]?.attributes?.find((a) => a.key === "output");
      const outVal = out && "stringValue" in out.value ? out.value.stringValue : "";
      expect(outVal!.length).toBe(8192); // capped at MAX_ATTR_CHARS
    },
  },
  {
    name: "timestamps_are_valid_ns_and_not_future",
    // Default clock (~1s ago) — NON-deterministic, so excluded from the cross-copy equality loop.
    input: { messages: [sys("r")] },
    deterministic: false,
    assert: (f) => {
      for (const s of f.spans) {
        expect(s.startTimeUnixNano).toMatch(/^\d+$/);
        expect(Number(s.startTimeUnixNano)).toBeLessThan(Date.now() * 1e6);
      }
    },
  },
];

/** Build the self-referential args object (its own vector cannot inline it without a `let`). */
function buildCircular(): Record<string, unknown> {
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  return circular;
}
