import { Link } from "react-router-dom";
import type { TraceListItem } from "../api/types.js";
import { formatDuration } from "../lib/duration.js";
import { EmptyState } from "./states.js";

/**
 * ok/error status indicator (M9). A trace's status is 'error' if any of its spans
 * errored, else 'ok' (set in the recompute). Accessible: the meaning is in the
 * label, not just a color.
 */
function StatusIndicator({ status }: { status: string | undefined }) {
  if (status == null) return <span className="trace-status">—</span>;
  const isError = status === "error";
  return (
    <span
      className={`trace-status status-${isError ? "error" : "ok"}`}
      aria-label={isError ? "status: error" : "status: ok"}
    >
      {isError ? "error" : "ok"}
    </span>
  );
}

/** Executions list (M3 DoD #1) — each row links to its trace view. */
export function TraceList({ traces }: { traces: TraceListItem[] }) {
  if (traces.length === 0) {
    return <EmptyState message="No executions yet" />;
  }
  return (
    <ul className="trace-list">
      {traces.map((t) => (
        <li key={t.traceId}>
          <Link to={`/traces/${t.traceId}`} className="trace-row">
            <span className="trace-name">{t.name ?? t.traceId}</span>
            <StatusIndicator status={t.statusCode} />
            <span className="trace-duration">{formatDuration(t.durationMs)}</span>
            {t.totalTokens != null && (
              <span className="trace-tokens">{t.totalTokens} tok</span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}
