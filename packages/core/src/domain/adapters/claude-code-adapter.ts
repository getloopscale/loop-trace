import type { AgentAdapter, AdapterSpanEvent } from "./agent-adapter.js";
import { serviceNameOf, stripContextWindowSuffix } from "./agent-adapter.js";
import { defaultAdapter } from "./default-adapter.js";
import type { GenAiFields } from "../genai-attributes.js";
import { toInt, capStringAttr } from "../attr-coerce.js";

/**
 * Read the tool result out of a `claude_code.tool` span's `tool.output` event
 * (M34). The result key varies by tool: `output` (Bash), `content` (Read/Write),
 * `diff` (Edit), `__truncated` (when Claude Code already capped it). First match
 * wins; the text is size-capped at the boundary (same M12 cap as input/output).
 */
const TOOL_OUTPUT_KEYS = ["output", "content", "diff", "__truncated"] as const;

function toolOutputFromEvents(
  events: readonly AdapterSpanEvent[] | undefined,
): string | undefined {
  for (const ev of events ?? []) {
    if (ev.name !== "tool.output") continue;
    const ea = ev.attributes ?? {};
    for (const k of TOOL_OUTPUT_KEYS) {
      const v = capStringAttr(ea[k]);
      if (v !== undefined) return v;
    }
  }
  return undefined;
}

/**
 * Claude Code adapter (M15 D2 + M34). Composes OVER the default adapter — Claude
 * uses the standard `gen_ai.request.model` + `gen_ai.system`, so model/provider
 * come from default — then overlays the non-standard bits the empirical captures
 * revealed:
 *
 *  - bare `input_tokens`/`output_tokens` (NOT `gen_ai.usage.*`) → typed token columns,
 *    but only as a FALLBACK (a future Claude carrying `gen_ai.usage.*` keeps that — EC-2).
 *  - model context-window suffix (`[1m]`/`[200k]`) stripped for clean grouping (EC-1).
 *  - the root interaction's `user_prompt` → `inputValue` (M12 input section), capped.
 *  - M34: `tool_name` → toolName (so `claude_code.tool` classifies as a tool + enters
 *    the Tools/Agents catalog); `full_command`/`file_path` → inputValue (tool input,
 *    a fallback to user_prompt); the `tool.output` event → outputValue (tool result);
 *    `ttft_ms` + `cache_read_tokens`/`cache_creation_tokens` → the typed perf/cost cols.
 *
 * Missing keys degrade to absent fields (never a throw) — the trace export is BETA
 * and its schema may change.
 */
export const claudeCodeAdapter: AgentAdapter = {
  name: "claude-code",
  matches: (resourceAttrs) => serviceNameOf(resourceAttrs) === "claude-code",
  extract: (attrs, spanName, events): GenAiFields => {
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

    // Tool name (M34): so a `claude_code.tool` span classifies as a tool + enters
    // the catalog. Falls back to the standard `gen_ai.tool.name` (in base) when absent.
    const toolName = capStringAttr(a["tool_name"]) ?? base.toolName;
    if (toolName !== undefined) out.toolName = toolName;

    // Input text (M34): user_prompt (interaction) wins; else the tool's input —
    // `full_command` (Bash) or `file_path` (Read/Write/Edit), capped.
    const inputValue =
      base.inputValue ??
      capStringAttr(a["user_prompt"]) ??
      capStringAttr(a["full_command"]) ??
      capStringAttr(a["file_path"]);
    if (inputValue !== undefined) out.inputValue = inputValue;

    // Output text (M34): the tool result lives in the `tool.output` event.
    const outputValue = base.outputValue ?? toolOutputFromEvents(events);
    if (outputValue !== undefined) out.outputValue = outputValue;

    // Perf + cost (M34): TTFT + prompt-cache token counts (string ints → coerce).
    const ttftMs = toInt(a["ttft_ms"]);
    const cacheReadTokens = toInt(a["cache_read_tokens"]);
    const cacheCreationTokens = toInt(a["cache_creation_tokens"]);
    if (ttftMs !== undefined) out.ttftMs = ttftMs;
    if (cacheReadTokens !== undefined) out.cacheReadTokens = cacheReadTokens;
    if (cacheCreationTokens !== undefined) {
      out.cacheCreationTokens = cacheCreationTokens;
    }

    return out;
  },
};
