import type { TraceListItem } from "../api/types.js";

/**
 * TracePicker (M21) — a recent-traces selector for the per-trace agent views.
 * A native `<select>` (accessible by default, fully keyboard-operable, testable)
 * styled with theme tokens. Presentational + controlled: the parent owns the
 * default-to-most-recent selection. Label is the trace name, falling back to its id.
 */
export function TracePicker({
  traces,
  value,
  onChange,
}: {
  traces: TraceListItem[];
  value: string;
  onChange: (traceId: string) => void;
}) {
  return (
    <select
      aria-label="select trace"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-border bg-card px-2 py-1 text-body-sm text-foreground"
    >
      {traces.map((t) => (
        <option key={t.traceId} value={t.traceId}>
          {t.name ?? t.traceId}
        </option>
      ))}
    </select>
  );
}
