import type { AgentAdapter } from "./agent-adapter.js";
import { defaultAdapter } from "./default-adapter.js";
import { claudeCodeAdapter } from "./claude-code-adapter.js";

/**
 * Adapter registry (M15 D1): specific adapters first, `default` last. Adding an
 * external agent = add its adapter here. `selectAdapter` runs once per resource
 * (service.name is resource-level) and returns the first match, falling back to
 * the universal default.
 */
const ADAPTERS: readonly AgentAdapter[] = [claudeCodeAdapter, defaultAdapter];

export function selectAdapter(
  resourceAttrs: Record<string, unknown> | undefined,
): AgentAdapter {
  const attrs = resourceAttrs ?? {};
  return ADAPTERS.find((a) => a.matches(attrs)) ?? defaultAdapter;
}
