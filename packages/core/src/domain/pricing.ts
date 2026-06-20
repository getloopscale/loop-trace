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
 * Total USD cost of a trace: `Σ (inputTokens·inputPerToken + outputTokens·outputPerToken)`
 * over each model's usage. Pure + deterministic (no clock/IO). A model absent from the
 * table contributes 0 (documented degradation — risk #1). Rounded to 6 decimals to
 * avoid float drift in storage/display.
 */
export function computeTraceCost(usage: ModelUsage[], table: PriceTable): number {
  let total = 0;
  for (const u of usage) {
    const price = table[u.model];
    if (price === undefined) continue;
    total += u.inputTokens * price.inputPerToken + u.outputTokens * price.outputPerToken;
  }
  return Math.round(total * 1e6) / 1e6;
}
