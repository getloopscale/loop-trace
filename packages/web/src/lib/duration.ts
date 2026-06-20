/** Duration in ms from OTLP nano timestamps (BigInt math — no 2^53 precision loss). */
export function durationMs(
  startNano: string,
  endNano?: string,
): number | undefined {
  if (endNano == null) return undefined;
  try {
    const d = Number((BigInt(endNano) - BigInt(startNano)) / 1_000_000n);
    return d >= 0 ? d : undefined;
  } catch {
    return undefined;
  }
}

/** Human label for a duration; em-dash when unknown. */
export function formatDuration(ms: number | undefined): string {
  if (ms == null) return "—";
  return ms < 1 ? "<1 ms" : `${ms} ms`;
}
