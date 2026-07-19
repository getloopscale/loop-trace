/**
 * Generic env-parse leaf (M120 D1). Owns the shared `positiveIntEnv` primitive — hoisted out of
 * `evaluator-config.ts` into a dependency-free leaf so `provider-config.ts` and `evaluator-config.ts`
 * can both import it from a common ancestor without re-forming the `chat → evaluator-config` cycle.
 * Imports nothing from the domain.
 */

/** Read a positive-integer env var; an unset/invalid/≤0 value falls back to `def` (never breaks
 *  boot on a fat-fingered env — fail-safe, `error-handling.md`). Shared by the M94 resilience config. */
export function positiveIntEnv(env: NodeJS.ProcessEnv, key: string, def: number): number {
  const raw = env[key];
  if (raw === undefined) return def;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : def;
}
