import type { PriceTable } from "./pricing.js";

/**
 * Public list price (USD per 1M tokens) → per-token. Cache rates (M52 / looptrace#71
 * Finding 1) are derived from the input rate with the authoritative Anthropic multipliers
 * (claude-api pricing ref): prompt-cache READ = 0.1× input, prompt-cache CREATION
 * (ephemeral 5-min, which Claude Code uses) = 1.25× input. OpenAI cached input is also
 * ~0.5× (read) with no separate write charge, but 0.1×/1.25× is the Anthropic default that
 * dominates our Claude Code ingest; providers whose real cache economics differ get an
 * explicit override rather than this derivation.
 */
function perMillion(input: number, output: number) {
  const inputPerToken = input / 1_000_000;
  return {
    inputPerToken,
    outputPerToken: output / 1_000_000,
    cacheReadPerToken: inputPerToken * 0.1,
    cacheCreationPerToken: inputPerToken * 1.25,
  };
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
  // Current Opus (4.6/4.7/4.8) is $5/$25; the legacy Opus 4.1 ($15/$75) gets a
  // longer key so longest-prefix routes "claude-opus-4-1*" to the legacy rate
  // while "claude-opus-4-8*" resolves to the current base key.
  "claude-opus-4": perMillion(5, 25),
  "claude-opus-4-1": perMillion(15, 75),
  "claude-sonnet-4": perMillion(3, 15),
  "claude-haiku-4": perMillion(1, 5),
};
