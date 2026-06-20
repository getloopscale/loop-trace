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

  return {
    ...(model !== undefined ? { model } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}
