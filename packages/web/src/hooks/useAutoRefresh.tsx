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

const STORAGE_KEY = "looptrace.autoRefreshMs";
const ALLOWED_MS = [5000, 10000, 30000, 60000];

/**
 * M31 Live mode — continuous fast-poll. When `live` is on, `useAutoRefreshInterval`
 * returns this cadence regardless of the dropdown (D3); fast enough to feel live, not
 * a hammer. Built on M16 polling (no SSE, no new dependency — D2).
 */
export const LIVE_MS = 2000;
const STORAGE_KEY_LIVE = "looptrace.live";

/** Read the persisted Live flag; defensive (disabled/corrupt store) → false. */
export function readStoredLive(): boolean {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY_LIVE);
  } catch {
    return false;
  }
  return raw === "true";
}

function writeStoredLive(live: boolean): void {
  try {
    if (live) localStorage.setItem(STORAGE_KEY_LIVE, "true");
    else localStorage.removeItem(STORAGE_KEY_LIVE);
  } catch {
    /* storage disabled / quota — in-memory state still holds */
  }
}

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
  /** M31: Live mode — continuous fast-poll overriding the interval. */
  live: boolean;
  setLive: (value: boolean) => void;
}

/** Default Off so a hook used WITHOUT the provider never polls (zero-regression, D2). */
const AutoRefreshContext = createContext<AutoRefreshContextValue>({
  intervalMs: false,
  setIntervalMs: () => {},
  live: false,
  setLive: () => {},
});

export function AutoRefreshProvider({ children }: { children: ReactNode }) {
  const [intervalMs, setIntervalMsState] =
    useState<AutoRefreshValue>(readStored);
  const [live, setLiveState] = useState<boolean>(readStoredLive);

  function setIntervalMs(value: AutoRefreshValue): void {
    setIntervalMsState(value);
    writeStored(value);
  }
  function setLive(value: boolean): void {
    setLiveState(value);
    writeStoredLive(value);
  }

  return (
    <AutoRefreshContext.Provider
      value={{ intervalMs, setIntervalMs, live, setLive }}
    >
      {children}
    </AutoRefreshContext.Provider>
  );
}

/** Read + set the shared interval + Live mode. */
export function useAutoRefresh(): AutoRefreshContextValue {
  return useContext(AutoRefreshContext);
}

/**
 * Read-only accessor the query hooks pass to react-query `refetchInterval`. Live mode
 * (M31) overrides the dropdown with the continuous `LIVE_MS` cadence (D1/D3).
 */
export function useAutoRefreshInterval(): AutoRefreshValue {
  const { intervalMs, live } = useContext(AutoRefreshContext);
  return live ? LIVE_MS : intervalMs;
}
