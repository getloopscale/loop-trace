import { capText } from "./span-events.js";

/**
 * Extract GenAI semantic-convention attributes from a span's flattened attribute
 * bag into typed fields. Attribute names are anchored on what langfuse actually
 * reads (OtelIngestionProcessor.ts) — both current and legacy token names — since
 * the OTel GenAI conventions moved to a separate repo (blueprint EC-1).
 */
/**
 * M1 scope: model, provider, input/output tokens (OTel `gen_ai.*` + OpenInference
 * `llm.*`). Cost is deferred to M5 (token×price); tool name and role/messages and
 * Vercel `ai.*` keys are deferred to a later milestone (review F-test-7 / F-otlp-3).
 */
export interface GenAiFields {
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Tool name of a tool-call span (`gen_ai.tool.name`), trim-normalized (M6). */
  toolName?: string;
  /** Span input text (`input.value`), capped (M12 — OpenInference convention). */
  inputValue?: string;
  /** Span output text (`output.value`), capped (M12). */
  outputValue?: string;
}

// Model resolution order (langfuse OtelIngestionProcessor.ts:2237-2242).
const MODEL_KEYS = [
  "gen_ai.response.model",
  "gen_ai.request.model",
  "llm.response.model",
  "llm.model_name",
  "model",
] as const;

function firstString(
  attrs: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const k of keys) {
    const v = attrs[k];
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  return undefined;
}

function toInt(value: unknown): number | undefined {
  if (value == null) return undefined;
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  return Number.isFinite(n) ? n : undefined;
}

/** Map flattened OTLP attributes → typed GenAI fields (only defined keys set). */
export function extractGenAi(attributes: unknown): GenAiFields {
  if (attributes == null || typeof attributes !== "object") return {};
  const attrs = attributes as Record<string, unknown>;

  const model = firstString(attrs, MODEL_KEYS);
  const provider = firstString(attrs, ["gen_ai.system", "gen_ai.provider.name"]);
  // current name first, then legacy (langfuse OtelIngestionProcessor.ts:2298-2322)
  const inputTokens = toInt(
    attrs["gen_ai.usage.input_tokens"] ?? attrs["gen_ai.usage.prompt_tokens"],
  );
  const outputTokens = toInt(
    attrs["gen_ai.usage.output_tokens"] ??
      attrs["gen_ai.usage.completion_tokens"],
  );
  // Tool name, trim-normalized (M6 risk #1); only set when non-empty after trim.
  const rawTool = firstString(attrs, ["gen_ai.tool.name"]);
  const toolName = rawTool !== undefined ? rawTool.trim() : "";

  // M12: input/output text (OpenInference input.value/output.value). Only a
  // non-empty STRING is extracted (EC-1: a non-string stays in the bag; EC-7: ""
  // is treated as absent) and it is size-capped at the boundary (D5).
  const inputValue = capStringAttr(attrs["input.value"]);
  const outputValue = capStringAttr(attrs["output.value"]);

  return {
    ...(model !== undefined ? { model } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(toolName !== "" ? { toolName } : {}),
    ...(inputValue !== undefined ? { inputValue } : {}),
    ...(outputValue !== undefined ? { outputValue } : {}),
  };
}

/** A non-empty string attribute, size-capped (M12 D5); anything else → undefined (EC-1/EC-7). */
function capStringAttr(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return capText(value);
}
