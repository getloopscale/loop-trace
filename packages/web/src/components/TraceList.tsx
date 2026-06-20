import { Link } from "react-router-dom";
import type { TraceListItem } from "../api/types.js";
import { formatDuration } from "../lib/duration.js";
import { EmptyState } from "./states.js";

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
            <span className="trace-status">{t.statusCode ?? "—"}</span>
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
