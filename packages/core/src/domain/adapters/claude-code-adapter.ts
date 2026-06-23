import type { AgentAdapter } from "./agent-adapter.js";
import { stripContextWindowSuffix } from "./agent-adapter.js";
import { defaultAdapter } from "./default-adapter.js";
import type { GenAiFields } from "../genai-attributes.js";
import { capText } from "./../span-events.js";

/** Parse a token attribute that may arrive as a number or an OTLP intValue string. */
function toInt(value: unknown): number | undefined {
  if (value == null) return undefined;
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  return Number.isFinite(n) ? n : undefined;
}

/** A non-empty string attribute, size-capped (reuses the M12 cap), else undefined. */
function capStringAttr(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return capText(value);
}

/**
 * Claude Code adapter (M15 D2). Composes OVER the default adapter — Claude uses the
 * standard `gen_ai.request.model` + `gen_ai.system`, so model/provider come from
 * default — then overlays the non-standard bits the empirical capture revealed:
 *
 *  - bare `input_tokens`/`output_tokens` (NOT `gen_ai.usage.*`) → typed token columns,
 *    but only as a FALLBACK (a future Claude carrying `gen_ai.usage.*` keeps that — EC-2).
 *  - model context-window suffix (`[1m]`/`[200k]`) stripped for clean grouping (EC-1).
 *  - the root interaction's `user_prompt` → `inputValue` (M12 input section), capped.
 *
 * Missing keys degrade to absent fields (never a throw) — the trace export is BETA
 * and its schema may change (D5).
 */
export const claudeCodeAdapter: AgentAdapter = {
  name: "claude-code",
  matches: (resourceAttrs) => resourceAttrs["service.name"] === "claude-code",
  extract: (attrs, spanName): GenAiFields => {
    const base = defaultAdapter.extract(attrs, spanName);
    const a = attrs ?? {};
    const out: GenAiFields = { ...base };

    // Model: strip the context-window suffix for consistent display/grouping.
    if (out.model !== undefined) out.model = stripContextWindowSuffix(out.model);

    // Tokens: prefer the standard key (already in base), fall back to Claude's bare keys.
    const inputTokens = base.inputTokens ?? toInt(a["input_tokens"]);
    const outputTokens = base.outputTokens ?? toInt(a["output_tokens"]);
    if (inputTokens !== undefined) out.inputTokens = inputTokens;
    if (outputTokens !== undefined) out.outputTokens = outputTokens;

    // Input text: the root interaction span carries `user_prompt`.
    const inputValue = base.inputValue ?? capStringAttr(a["user_prompt"]);
    if (inputValue !== undefined) out.inputValue = inputValue;

    return out;
  },
};
