import type { GenAiFields } from "../observability/genai-attributes.js";

/**
 * A span event as seen by an adapter — the parsed `{name, attributes}` shape
 * (M34). The tool OUTPUT of a Claude Code `claude_code.tool` span lives in a
 * `tool.output` event's attributes (`output`/`content`/`diff`/`__truncated`),
 * NOT in span attributes — so adapters need to see events to map it.
 */
export interface AdapterSpanEvent {
  readonly name: string;
  readonly attributes?: Record<string, unknown>;
}

/**
 * An adapter maps ONE external agent's OTLP span attribute convention into the
 * normalized typed fields (model/provider/tokens/input/output/tool) LoopTrace
 * stores (M15). Adapters are selected by `service.name` (a resource attribute),
 * so adding a new agent (Codex, …) is "implement this interface + register one
 * entry" — the pipeline, schema, DTOs, and UI never change per agent (D1).
 *
 * Leaf module: imports nothing from sibling adapters (the registry composes them),
 * so there is no import cycle.
 */
export interface AgentAdapter {
  /** Stable id, e.g. "claude-code", "default". */
  readonly name: string;
  /** True when this adapter handles spans from the given resource (by service.name). */
  matches(resourceAttrs: Record<string, unknown>): boolean;
  /**
   * Map a span's flattened attributes (+ optional parsed events) → normalized
   * typed fields. `events` is OPTIONAL (M34 D1): the default adapter ignores it,
   * so every existing caller compiles unchanged.
   */
  extract(
    attrs: Record<string, unknown> | undefined,
    spanName: string,
    events?: readonly AdapterSpanEvent[],
  ): GenAiFields;
}

/** `service.name` from flattened resource attributes, or undefined. */
export function serviceNameOf(
  resourceAttrs: Record<string, unknown> | undefined,
): string | undefined {
  const v = resourceAttrs?.["service.name"];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Strip a trailing context-window bracket suffix from a model id (M15 EC-1):
 * `claude-opus-4-8[1m]` / `[200k]` → `claude-opus-4-8`; an id without a bracket is
 * returned unchanged. Generic (any `[...]`), not a literal `[1m]`.
 */
export function stripContextWindowSuffix(model: string): string {
  return model.replace(/\s*\[[^\]]*\]$/, "");
}
