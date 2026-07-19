import type { AgentAdapter } from "./agent-adapter.js";
import { serviceNameOf } from "./agent-adapter.js";
import { defaultAdapter } from "./default-adapter.js";
import type { GenAiFields } from "../observability/genai-attributes.js";
import { toInt } from "../attr-coerce.js";

/**
 * `@theokit/sdk` / Claude Code `SDKMessage` adapter (M115). The SDK-side translator
 * (`@usetheo/lens-sdk` `sdkMessagesToOtlp`) emits STANDARD `gen_ai.*` attributes — so model,
 * provider, input/output tokens, tool name, and input/output text come from the default adapter
 * unchanged (ADR-1). This adapter composes OVER default and overlays ONLY the prompt-cache token
 * counts the translator emits under the standard-shaped `gen_ai.usage.cache_*_input_tokens` keys,
 * which `extractGenAi` does not read.
 *
 * A SEPARATE `service.name` (`theokit-sdk`) — NOT reused from `claude-code` — so `@theokit/sdk` runs
 * attribute + enter the agents catalog distinctly (owner decision, blueprint ADR-D3). Missing keys
 * degrade to absent fields (never a throw). Leaf module: imports no sibling adapter.
 */
export const theokitSdkAdapter: AgentAdapter = {
  name: "theokit-sdk",
  matches: (resourceAttrs) => serviceNameOf(resourceAttrs) === "theokit-sdk",
  extract: (attrs, spanName, events): GenAiFields => {
    const base = defaultAdapter.extract(attrs, spanName, events);
    const a = attrs ?? {};
    const out: GenAiFields = { ...base };

    // Prompt-cache token counts (the translator's standard-shaped keys; not read by extractGenAi).
    const cacheReadTokens = toInt(a["gen_ai.usage.cache_read_input_tokens"]);
    const cacheCreationTokens = toInt(a["gen_ai.usage.cache_creation_input_tokens"]);
    if (cacheReadTokens !== undefined) out.cacheReadTokens = cacheReadTokens;
    if (cacheCreationTokens !== undefined) out.cacheCreationTokens = cacheCreationTokens;

    return out;
  },
};
