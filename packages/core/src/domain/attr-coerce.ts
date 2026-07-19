import { capText } from "./observability/span-events.js";

/**
 * Shared attribute-coercion plumbing used by `extractGenAi` and the agent adapters
 * (single source — avoids a per-adapter copy). OTLP intValue arrives as a string;
 * `toInt` accepts string or number. `capStringAttr` returns a non-empty string
 * size-capped (M12 cap), else undefined.
 */
export function toInt(value: unknown): number | undefined {
  if (value == null) return undefined;
  const n = typeof value === "number" ? value : parseInt(String(value), 10);
  return Number.isFinite(n) ? n : undefined;
}

export function capStringAttr(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return capText(value);
}
