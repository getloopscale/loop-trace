import { z } from "zod";

/**
 * Agents catalog (M32) — a derived read-path registry of agents as first-class
 * entities, grouped by the explicit `agent.name` span attribute (the documented
 * `agent.*` convention, like `eval.*` in M26). Distinct from the M21 per-trace Agent
 * Graph (which groups every span name); the catalog lists DECLARED agents only.
 *
 * Health is computed by the PURE `classifyAgentHealth` (injected clock + thresholds),
 * so the SQL aggregate only supplies raw counts + timestamps and the unit test owns
 * the health logic deterministically.
 */
export const AGENT_STALE_DAYS = 30;
export const AGENT_CHURN_THRESHOLD = 3;
export const AGENT_SYSTEM_PROMPT_MAX = 500;

/** One agent in the catalog. `.strict()` so DB columns never leak. */
export const agentSchema = z
  .object({
    name: z.string(),
    firstSeenAt: z.string(),
    latestSeenAt: z.string(),
    /** Distinct traces the agent appears in. */
    runCount: z.number().int().nonnegative(),
    /** Distinct `agent.version` values, sorted. */
    versions: z.array(z.string()),
    /** Number of versions = the "generations" dimension. */
    versionCount: z.number().int().nonnegative(),
    /** Distinct tool names used across the agent's traces. */
    tools: z.array(z.string()),
    /** Latest non-empty `agent.system_prompt`, capped (preview). */
    systemPrompt: z.string().optional(),
    /** Health: latest-seen older than the stale window. */
    stale: z.boolean(),
    /** Health: many versions (≥ churn threshold). */
    highChurn: z.boolean(),
    /** Health: the agent has a blank/whitespace name. */
    anonymous: z.boolean(),
  })
  .strict();

export type Agent = z.infer<typeof agentSchema>;

export const agentCatalogResponseSchema = z
  .object({ agents: z.array(agentSchema) })
  .strict();

export type AgentCatalogResponse = z.infer<typeof agentCatalogResponseSchema>;

/** Raw per-agent aggregate from the DB, before pure shaping. */
export interface RawAgent {
  name: string;
  firstSeenAt: string;
  latestSeenAt: string;
  runCount: number;
  versions: string[];
  tools: string[];
  systemPrompt?: string | null;
}

export interface AgentHealthConfig {
  now: Date;
  staleDays?: number;
  churnThreshold?: number;
}

/**
 * PURE health classification (M32 D3). Deterministic — the clock + thresholds are
 * injected (never `Date.now()` / SQL `now()`), so the test owns the boundary. Stale:
 * latest-seen strictly older than `staleDays`. High churn: `versionCount` ≥ threshold.
 * Anonymous: a blank/whitespace agent name.
 */
export function classifyAgentHealth(
  input: { name: string; latestSeenAt: string; versionCount: number },
  config: AgentHealthConfig,
): { stale: boolean; highChurn: boolean; anonymous: boolean } {
  const staleDays = config.staleDays ?? AGENT_STALE_DAYS;
  const churnThreshold = config.churnThreshold ?? AGENT_CHURN_THRESHOLD;
  const cutoff = config.now.getTime() - staleDays * 86_400_000;
  const seen = new Date(input.latestSeenAt).getTime();
  const stale = Number.isFinite(seen) ? seen < cutoff : false;
  return {
    stale,
    highChurn: input.versionCount >= churnThreshold,
    anonymous: input.name.trim().length === 0,
  };
}

/** Assemble a {@link RawAgent} + pure health into the catalog DTO (M32). */
export function shapeAgent(raw: RawAgent, config: AgentHealthConfig): Agent {
  const versions = [...raw.versions].sort();
  const health = classifyAgentHealth(
    { name: raw.name, latestSeenAt: raw.latestSeenAt, versionCount: versions.length },
    config,
  );
  const prompt = raw.systemPrompt?.trim();
  return {
    name: raw.name,
    firstSeenAt: raw.firstSeenAt,
    latestSeenAt: raw.latestSeenAt,
    runCount: raw.runCount,
    versions,
    versionCount: versions.length,
    tools: [...raw.tools].sort(),
    ...(prompt
      ? { systemPrompt: prompt.length > AGENT_SYSTEM_PROMPT_MAX ? `${prompt.slice(0, AGENT_SYSTEM_PROMPT_MAX)}…` : prompt }
      : {}),
    ...health,
  };
}
