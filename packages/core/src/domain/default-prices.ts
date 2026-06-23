import type { PriceTable } from "./pricing.js";

/** Public list price (USD per 1M tokens) → per-token. */
function perMillion(input: number, output: number) {
  return { inputPerToken: input / 1_000_000, outputPerToken: output / 1_000_000 };
}

/**
 * Default per-model price table (config-as-code — M5 ADR D1 / risk #1). USD per
 * token, derived from public list prices per 1M tokens. This is the single place to
 * update when providers change pricing; a change applies to NEW ingests (a backfill
 * of historical `traces.cost_usd` is a documented follow-up). Unknown models cost 0.
 * Override by injecting a different `PriceTable` into the repository.
 */
export const DEFAULT_PRICES: PriceTable = {
  // OpenAI
  "gpt-4o": perMillion(2.5, 10),
  "gpt-4o-mini": perMillion(0.15, 0.6),
  "gpt-4-turbo": perMillion(10, 30),
  "gpt-4": perMillion(30, 60),
  "gpt-3.5-turbo": perMillion(0.5, 1.5),
  // Anthropic — Claude 3.x
  "claude-3-5-sonnet": perMillion(3, 15),
  "claude-3-5-haiku": perMillion(0.8, 4),
  "claude-3-opus": perMillion(15, 75),
  "claude-3-sonnet": perMillion(3, 15),
  "claude-3-haiku": perMillion(0.25, 1.25),
  // Anthropic — Claude 4.x (base-version keys; longest-prefix resolves dated/
  // context-window variants like "claude-opus-4-8" / "claude-opus-4-8[1m]" — M15).
  // Public list prices per 1M tokens; update here when Anthropic changes them.
  "claude-opus-4": perMillion(15, 75),
  "claude-sonnet-4": perMillion(3, 15),
  "claude-haiku-4": perMillion(1, 5),
};
