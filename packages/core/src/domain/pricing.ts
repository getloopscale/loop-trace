/** Per-model USD price, per single token, split by input vs output (M5 ADR D1). */
export interface ModelPrice {
  inputPerToken: number;
  outputPerToken: number;
}

/** Configurable price table: model name → price. Injectable (DIP) for risk #1. */
export type PriceTable = Record<string, ModelPrice>;

/** Per-model token usage of a trace (summed from its spans). */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
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
 * Total USD cost of a trace: `Σ (inputTokens·inputPerToken + outputTokens·outputPerToken)`
 * over each model's usage. Pure + deterministic (no clock/IO). A model with no matching
 * price (exact or prefix) contributes 0 (documented degradation — risk #1). Rounded to 6
 * decimals to bound float drift in storage/display.
 */
export function computeTraceCost(usage: ModelUsage[], table: PriceTable): number {
  let total = 0;
  for (const u of usage) {
    const price = resolveModelPrice(u.model, table);
    if (price === undefined) continue;
    total += u.inputTokens * price.inputPerToken + u.outputTokens * price.outputPerToken;
  }
  return Math.round(total * 1e6) / 1e6;
}
