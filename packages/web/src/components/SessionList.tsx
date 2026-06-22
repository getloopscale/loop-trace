import { Link } from "react-router-dom";
import type { SessionListItem } from "../api/types.js";
import { formatUsd } from "../lib/money.js";
import { EmptyState } from "./states.js";

/** error-rate (0..1) → a compact percentage label. */
function formatRate(rate: number): string {
  return `${+(rate * 100).toFixed(1)}%`;
}

/**
 * Sessions list (M13) — each row links to its session view. The empty state
 * documents the honest fallback (D3): sessions require an explicit `session.id`
 * attribute; ungrouped traces stay standalone and are not fabricated into sessions.
 */
export function SessionList({ sessions }: { sessions: SessionListItem[] }) {
  if (sessions.length === 0) {
    return (
      <EmptyState message="No sessions yet — sessions group traces that carry a session.id (or gen_ai.conversation.id) attribute; traces without one stay standalone." />
    );
  }
  return (
    <table className="session-list">
      <caption>Sessions</caption>
      <thead>
        <tr>
          <th scope="col">Session</th>
          <th scope="col">Traces</th>
          <th scope="col">Cost</th>
          <th scope="col">Tokens</th>
          <th scope="col">Error rate</th>
          <th scope="col">Last seen</th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((s) => (
          <tr key={s.sessionId}>
            <td>
              <Link to={`/sessions/${encodeURIComponent(s.sessionId)}`}>
                {s.sessionId}
              </Link>
            </td>
            <td>{s.traceCount}</td>
            <td>{formatUsd(s.costUsd)}</td>
            <td>{s.totalTokens}</td>
            <td>{formatRate(s.errorRate)}</td>
            <td>{s.lastSeenAt}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
