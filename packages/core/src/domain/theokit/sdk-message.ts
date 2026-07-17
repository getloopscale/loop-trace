/**
 * Local mirror of the Claude Code / `@theokit/sdk` `SDKMessage` stream union + `RunResult`
 * usage/cost (M115, ADR-2). We mirror rather than `import type` from `@theokit/sdk` so
 * the core copy powers the native `/v1/runs` endpoint (M116); it mirrors the SDK copy verbatim, guarded by shared test vectors (the v11/v12 constraint) and is not coupled to a
 * fast-moving SDK version. The hermetic contract test (`theokit-contract.integration.test.ts`)
 * is the drift guard: it proves the mapping against the real engine.
 *
 * Source of truth mirrored: `theokit-tools/theokit-sdk/packages/sdk/dist/types/messages.d.ts`
 * (the `SDKMessage` discriminated union) + `run.d.ts` (`RunResult.usage`/`cost`). Tool `args`/
 * `result` are explicitly "NOT part of the stable schema — treat as unknown" — so they are
 * `unknown` here and parsed defensively at the mapping boundary.
 *
 * @public
 */

/** A text content block. */
export interface TextBlock {
  readonly type: "text";
  readonly text: string;
}

/** A tool invocation block emitted by the assistant. `input` is unstable → `unknown`. */
export interface ToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** A model selection: an id + optional params. Mirrors `@theokit/sdk` `ModelSelection`. */
export interface ModelSelection {
  readonly id: string;
  readonly params?: readonly unknown[];
}

/** Init metadata, emitted once at the start of a run. `model` is a `ModelSelection` on the wire (a
 *  `string` is also accepted for a simple shape); the mapper extracts `.id` defensively. */
export interface SDKSystemMessage {
  readonly type: "system";
  readonly subtype?: "init";
  readonly agent_id: string;
  readonly run_id: string;
  readonly model?: string | ModelSelection;
  readonly tools?: readonly string[];
}

/** Echo of the user prompt for this run. */
export interface SDKUserMessageEvent {
  readonly type: "user";
  readonly agent_id: string;
  readonly run_id: string;
  readonly message: { readonly role: "user"; readonly content: readonly TextBlock[] };
}

/** Model text output for this run (+ any tool_use blocks). */
export interface SDKAssistantMessage {
  readonly type: "assistant";
  readonly agent_id: string;
  readonly run_id: string;
  readonly message: {
    readonly role: "assistant";
    readonly content: ReadonlyArray<TextBlock | ToolUseBlock>;
  };
}

/** Reasoning content. */
export interface SDKThinkingMessage {
  readonly type: "thinking";
  readonly agent_id: string;
  readonly run_id: string;
  readonly text: string;
  readonly thinking_duration_ms?: number;
}

/** Tool invocation lifecycle. `args`/`result` are unstable → `unknown`. `truncated` flags that the
 *  runtime already capped `args`/`result` before emitting them. */
export interface SDKToolUseMessage {
  readonly type: "tool_call";
  readonly agent_id: string;
  readonly run_id: string;
  readonly call_id: string;
  readonly name: string;
  readonly status: "running" | "completed" | "error";
  readonly args?: unknown;
  readonly result?: unknown;
  readonly truncated?: { readonly args?: boolean; readonly result?: boolean };
}

/** Cloud run lifecycle transitions. */
export interface SDKStatusMessage {
  readonly type: "status";
  readonly agent_id: string;
  readonly run_id: string;
  readonly status: "CREATING" | "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED" | "EXPIRED";
  readonly message?: string;
}

/** Task-level milestones and summaries. */
export interface SDKTaskMessage {
  readonly type: "task";
  readonly agent_id: string;
  readonly run_id: string;
  readonly status?: string;
  readonly text?: string;
}

/** Awaiting user input or approval. */
export interface SDKRequestMessage {
  readonly type: "request";
  readonly agent_id: string;
  readonly run_id: string;
  readonly request_id: string;
}

/** Partial object during `streamObject` streaming. */
export interface SDKObjectDelta {
  readonly type: "object_delta";
  readonly agent_id: string;
  readonly run_id: string;
  readonly partial: unknown;
  readonly attempt: number;
}

/** The full `SDKMessage` discriminated union — discriminate on `type`. */
export type SDKMessage =
  | SDKSystemMessage
  | SDKUserMessageEvent
  | SDKAssistantMessage
  | SDKThinkingMessage
  | SDKToolUseMessage
  | SDKStatusMessage
  | SDKTaskMessage
  | SDKRequestMessage
  | SDKObjectDelta;

/** Token usage observed for a run (`RunResult.usage`). */
export interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
}

/** Estimated/actual USD cost for a run (`RunResult.cost`). Advisory only (ADR-4). */
export interface CostBreakdown {
  readonly totalUsd?: number;
  readonly status?: string;
}

/** The terminal run result carrying usage + cost (arrives ONCE, at run end). */
export interface RunResult {
  readonly usage?: TokenUsage;
  readonly cost?: CostBreakdown;
}
