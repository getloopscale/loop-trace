import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";
import type { ObservabilityRange } from "../api/types.js";

/**
 * Global time range (M29b) — the single time control shared by the Dashboard, the
 * 24h summary strip, and the executions list (replacing the toolbar From/To inputs).
 * Mirrors the `AutoRefreshProvider` shape: a context + defensive localStorage so a
 * disabled/private/corrupt store falls back to the default and never crashes boot.
 */

/** Operator-facing presets (aligned with `ObservabilityRange`). */
export const RANGE_OPTIONS = [
  { label: "Last 1 hour", value: "1h" },
  { label: "Last 24 hours", value: "24h" },
  { label: "Last 7 days", value: "7d" },
  { label: "Last 30 days", value: "30d" },
] as const satisfies ReadonlyArray<{ label: string; value: ObservabilityRange }>;

const STORAGE_KEY = "looptrace.range";
const DEFAULT_RANGE: ObservabilityRange = "7d";
const ALLOWED: ReadonlyArray<ObservabilityRange> = ["1h", "24h", "7d", "30d"];

/** Milliseconds spanned by each preset. */
const RANGE_MS: Record<ObservabilityRange, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

/**
 * Convert a preset to a `{from,to}` ISO window relative to `now` (injected — pure,
 * deterministic, testable). `to` is `now`; `from` is `now − preset`.
 */
export function rangeToWindow(
  range: ObservabilityRange,
  now: number,
): { from: string; to: string } {
  return {
    from: new Date(now - RANGE_MS[range]).toISOString(),
    to: new Date(now).toISOString(),
  };
}

/** Read the persisted range; defensive on every axis (EC-1) → default on any failure. */
export function readStoredRange(): ObservabilityRange {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return DEFAULT_RANGE;
  }
  if (raw == null) return DEFAULT_RANGE;
  return (ALLOWED as readonly string[]).includes(raw)
    ? (raw as ObservabilityRange)
    : DEFAULT_RANGE;
}

function writeStoredRange(range: ObservabilityRange): void {
  try {
    localStorage.setItem(STORAGE_KEY, range);
  } catch {
    /* storage disabled / quota — in-memory state still holds */
  }
}

interface RangeContextValue {
  range: ObservabilityRange;
  setRange: (range: ObservabilityRange) => void;
}

const RangeContext = createContext<RangeContextValue>({
  range: DEFAULT_RANGE,
  setRange: () => {},
});

export function RangeProvider({ children }: { children: ReactNode }) {
  const [range, setRangeState] = useState<ObservabilityRange>(readStoredRange);
  function setRange(value: ObservabilityRange): void {
    setRangeState(value);
    writeStoredRange(value);
  }
  return (
    <RangeContext.Provider value={{ range, setRange }}>
      {children}
    </RangeContext.Provider>
  );
}

/** Read + set the shared global range. */
export function useRange(): RangeContextValue {
  return useContext(RangeContext);
}
