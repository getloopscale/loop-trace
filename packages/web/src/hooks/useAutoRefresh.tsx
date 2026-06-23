import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";

/** Auto-refresh interval in ms, or `false` for Off (D1/D2). */
export type AutoRefreshValue = number | false;

/** Operator-facing interval choices (Grafana/Jaeger convention). */
export const AUTO_REFRESH_OPTIONS = [
  { label: "Off", ms: false },
  { label: "5s", ms: 5000 },
  { label: "10s", ms: 10000 },
  { label: "30s", ms: 30000 },
  { label: "1m", ms: 60000 },
] as const satisfies ReadonlyArray<{ label: string; ms: AutoRefreshValue }>;

const STORAGE_KEY = "theolens.autoRefreshMs";
const ALLOWED_MS = [5000, 10000, 30000, 60000];

/**
 * Read the persisted interval. Defensive on every axis (EC-1): a missing key,
 * corrupt JSON, an out-of-set number, OR a throwing localStorage (private mode /
 * disabled storage) all fall back to Off — never crash app boot.
 */
export function readStored(): AutoRefreshValue {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return false;
  }
  if (raw == null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (parsed === false) return false;
  if (typeof parsed === "number" && ALLOWED_MS.includes(parsed)) return parsed;
  return false;
}

/** Persist the interval; swallow storage failures (EC-1) — keep in-memory state. */
function writeStored(ms: AutoRefreshValue): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ms));
  } catch {
    /* storage disabled / quota exceeded — in-memory state still holds */
  }
}

interface AutoRefreshContextValue {
  intervalMs: AutoRefreshValue;
  setIntervalMs: (value: AutoRefreshValue) => void;
}

/** Default Off so a hook used WITHOUT the provider never polls (zero-regression, D2). */
const AutoRefreshContext = createContext<AutoRefreshContextValue>({
  intervalMs: false,
  setIntervalMs: () => {},
});

export function AutoRefreshProvider({ children }: { children: ReactNode }) {
  const [intervalMs, setIntervalMsState] =
    useState<AutoRefreshValue>(readStored);

  function setIntervalMs(value: AutoRefreshValue): void {
    setIntervalMsState(value);
    writeStored(value);
  }

  return (
    <AutoRefreshContext.Provider value={{ intervalMs, setIntervalMs }}>
      {children}
    </AutoRefreshContext.Provider>
  );
}

/** Read + set the shared interval. */
export function useAutoRefresh(): AutoRefreshContextValue {
  return useContext(AutoRefreshContext);
}

/** Read-only accessor the query hooks pass to react-query `refetchInterval`. */
export function useAutoRefreshInterval(): AutoRefreshValue {
  return useContext(AutoRefreshContext).intervalMs;
}
