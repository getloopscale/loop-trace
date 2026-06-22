/** A rate in [0,1] → a compact percentage label, e.g. 0.25 → "25%", 0.333 → "33.3%". */
export function formatPercent(rate: number): string {
  return `${+(rate * 100).toFixed(1)}%`;
}
