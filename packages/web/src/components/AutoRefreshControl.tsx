import { useEffect, useState } from "react";
import {
  AUTO_REFRESH_OPTIONS,
  useAutoRefresh,
  type AutoRefreshValue,
} from "../hooks/useAutoRefresh.js";

function encode(ms: AutoRefreshValue): string {
  return ms === false ? "off" : String(ms);
}

function decode(value: string): AutoRefreshValue {
  return value === "off" ? false : Number(value);
}

/**
 * Re-render once per second while `active` so the "updated Xs ago" label stays
 * honest (D3). Off → the tick never arms; cleared on unmount / when toggled Off.
 */
function useNowTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * Toolbar control: pick the auto-refresh interval (Off/5s/10s/30s/1m) and see
 * how stale the data is. The interval feeds react-query `refetchInterval` via the
 * shared context; `dataUpdatedAt` is the active query's last-success timestamp.
 */
export function AutoRefreshControl({
  dataUpdatedAt,
}: {
  dataUpdatedAt?: number;
}) {
  const { intervalMs, setIntervalMs } = useAutoRefresh();
  const active = intervalMs !== false;
  const now = useNowTick(active);
  const secondsAgo =
    active && dataUpdatedAt
      ? Math.max(0, Math.round((now - dataUpdatedAt) / 1000))
      : null;

  return (
    <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
      <label className="inline-flex items-center gap-1.5">
        Auto-refresh{" "}
        <select
          className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
          value={encode(intervalMs)}
          onChange={(e) => setIntervalMs(decode(e.target.value))}
        >
          {AUTO_REFRESH_OPTIONS.map((opt) => (
            <option key={opt.label} value={encode(opt.ms)}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
      {secondsAgo !== null && (
        <span
          className="tabular-nums text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          {" "}
          updated {secondsAgo}s ago
        </span>
      )}
    </span>
  );
}
