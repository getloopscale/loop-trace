const USD = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 4,
});

/** Format a USD amount, e.g. `0.0125` → "$0.0125", `0` → "$0.00". */
export function formatUsd(amount: number): string {
  return USD.format(amount);
}
