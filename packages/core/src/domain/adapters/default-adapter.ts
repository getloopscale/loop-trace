import type { AgentAdapter } from "./agent-adapter.js";
import { extractGenAi } from "../genai-attributes.js";

/**
 * The generic adapter (M15 D1): the existing `gen_ai.*` / OpenInference `llm.*`
 * extraction, unchanged. `matches` is always true so it is the universal fallback
 * (the registry tries specific adapters first, default last). Delegating to
 * `extractGenAi` verbatim guarantees ZERO regression — every existing trace
 * extracts exactly as before.
 */
export const defaultAdapter: AgentAdapter = {
  name: "default",
  matches: () => true,
  extract: (attrs) => extractGenAi(attrs),
};
