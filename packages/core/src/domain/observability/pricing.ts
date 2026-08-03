/**
 * Per-model USD price, per single token, split by input vs output (M5 ADR D1).
 * Cache rates (M52 / theo-lens#71 Finding 1) are OPTIONAL for backward compatibility:
 * a price row without them prices cache tokens at 0. Authoritative Anthropic multipliers
 * (claude-api pricing ref): cache-read = 0.1× input, cache-creation (ephemeral 5-min,
 * which Claude Code uses) = 1.25× input.
 */
import { roundUsd } from "./tool-stats.js";

export interface ModelPrice {
  inputPerToken: number;
  outputPerToken: number;
  cacheReadPerToken?: number;
  cacheCreationPerToken?: number;
}

/** Configurable price table: model name → price. Injectable (DIP) for risk #1. */
export type PriceTable = Record<string, ModelPrice>;

/** Per-model token usage of a trace (summed from its spans). */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/**
 * Resolve a model's price: exact match first, else the LONGEST table key that is a
 * prefix of the model id — so dated/snapshot ids ("gpt-4o-2024-08-06",
 * "claude-3-5-sonnet-20241022") price as their base model, while "gpt-4o-mini"
 * still resolves to itself (longest prefix wins over "gpt-4o"). Unknown → undefined.
 */
export function resolveModelPrice(
  model: string,
  table: PriceTable,
): ModelPrice | undefined {
  const exact = table[model];
  if (exact !== undefined) return exact;
  let bestKey: string | undefined;
  for (const key of Object.keys(table)) {
    if (model.startsWith(key) && (bestKey === undefined || key.length > bestKey.length)) {
      bestKey = key;
    }
  }
  return bestKey !== undefined ? table[bestKey] : undefined;
}

/**
 * Total USD cost of a trace: `Σ (inputTokens·inputPerToken + outputTokens·outputPerToken
 * + cacheReadTokens·cacheReadPerToken + cacheCreationTokens·cacheCreationPerToken)` over
 * each model's usage (M52 / theo-lens#71 Finding 1 — cache tokens were previously excluded,
 * materially understating cost for cache-heavy agents like Claude Code). Pure + deterministic
 * (no clock/IO). A model with no matching price (exact or prefix) contributes 0 (documented
 * degradation — risk #1); a cache token count with no matching cache rate also contributes 0
 * (backward compat). Rounded to 6 decimals to bound float drift in storage/display.
 */
export function computeTraceCost(usage: ModelUsage[], table: PriceTable): number {
  let total = 0;
  for (const u of usage) {
    const price = resolveModelPrice(u.model, table);
    if (price === undefined) continue;
    total += u.inputTokens * price.inputPerToken + u.outputTokens * price.outputPerToken;
    if (price.cacheReadPerToken !== undefined) {
      total += (u.cacheReadTokens ?? 0) * price.cacheReadPerToken;
    }
    if (price.cacheCreationPerToken !== undefined) {
      total += (u.cacheCreationTokens ?? 0) * price.cacheCreationPerToken;
    }
  }
  // A precisão de USD vive em `roundUsd` (tool-stats), não inline aqui: quando ela estava
  // duplicada, o agregado de sessão divergiu para 3 casas e zerou custos reais (#121).
  return roundUsd(total);
}
