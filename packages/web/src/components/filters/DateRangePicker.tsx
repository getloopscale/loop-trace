import { useRange, RANGE_OPTIONS } from "../../hooks/useRange.js";
import type { ObservabilityRange } from "../../api/types.js";

/**
 * Global date-range picker (M29b) — the single time control, in the top bar. A
 * token-styled native `<select>` (Radix Select is jsdom-flaky, M24 lesson) bound to
 * the shared `useRange` context; it drives the Dashboard, the 24h summary strip, and
 * the executions list. No raw hex; labelled for a11y.
 */
export function DateRangePicker() {
  const { range, setRange } = useRange();
  return (
    <label className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      <span className="sr-only">Date range</span>
      <select
        aria-label="date range"
        value={range}
        onChange={(e) => setRange(e.target.value as ObservabilityRange)}
        className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        {RANGE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
