import { Link } from "react-router-dom";
import { Badge, DataTable, Timestamp, type DataTableColumn } from "@usetheo/ui";
import type { SessionListItem } from "../../api/types.js";
import { formatUsd } from "../../lib/money.js";
import { EmptyState } from "../primitives/States.js";

const DASH = "—";

/** ISO timestamp → Unix ms (theo-ui Timestamp expects ms). NaN-safe. */
function isoToMs(iso: string): number | undefined {
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Human session duration from start/end ISO timestamps. Clamps to non-negative
 * (EC-4: clock skew / equal timestamps → "0s", never negative/NaN). Sessions span
 * seconds→hours, so this formats s/m/h (unlike the ms-scale span formatDuration).
 */
export function sessionDuration(firstSeenAt: string, lastSeenAt: string): string {
  const start = isoToMs(firstSeenAt);
  const end = isoToMs(lastSeenAt);
  if (start == null || end == null) return DASH;
  const ms = Math.max(0, end - start);
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const columns: DataTableColumn<SessionListItem>[] = [
  {
    key: "firstMessage",
    label: "First message",
    render: (s) => (
      <Link
        to={`/sessions/${encodeURIComponent(s.sessionId)}`}
        className="block max-w-[40ch] truncate text-primary"
        title={s.firstMessagePreview ?? s.sessionId}
      >
        {s.firstMessagePreview ?? s.sessionId}
      </Link>
    ),
  },
  {
    key: "messages",
    label: "Messages",
    align: "right",
    // One trace = one agent turn = one message (D2): traceCount is the message count.
    render: (s) => s.traceCount,
  },
  {
    key: "duration",
    label: "Duration",
    align: "right",
    render: (s) => sessionDuration(s.firstSeenAt, s.lastSeenAt),
  },
  {
    key: "tokens",
    label: "Tokens",
    align: "right",
    render: (s) => s.totalTokens,
  },
  {
    key: "cost",
    label: "Cost",
    align: "right",
    render: (s) => formatUsd(s.costUsd),
  },
  {
    // M26d: per-session online-eval count (session-level twin of the trace Evals column).
    key: "evals",
    label: "Evals",
    align: "right",
    render: (s) =>
      s.evaluationsCount == null ? (
        <span className="text-muted-foreground">{DASH}</span>
      ) : (
        <Badge variant="outline" size="sm" aria-label={`${s.evaluationsCount} evaluations`}>
          {s.evaluationsCount}
        </Badge>
      ),
  },
  {
    key: "start",
    label: "Start",
    render: (s) => {
      const ms = isoToMs(s.firstSeenAt);
      return ms == null ? DASH : <Timestamp value={ms} format="relative" />;
    },
  },
  {
    key: "end",
    label: "End",
    render: (s) => {
      const ms = isoToMs(s.lastSeenAt);
      return ms == null ? DASH : <Timestamp value={ms} format="relative" />;
    },
  },
];

/**
 * Arize-style dense sessions table (M20). Built on theo-ui DataTable, led by the
 * session's first user message (M20 query enrichment); each row links to the
 * session view. Empty state documents the honest D3 fallback (sessions require a
 * session.id; ungrouped traces stay standalone, not fabricated into sessions).
 */
export function SessionTable({ sessions }: { sessions: SessionListItem[] }) {
  if (sessions.length === 0) {
    return (
      <EmptyState message="No sessions yet — sessions group traces that carry a session.id (or gen_ai.conversation.id) attribute; traces without one stay standalone." />
    );
  }
  return (
    <DataTable
      data={sessions}
      columns={columns}
      rowKey={(s) => s.sessionId}
      emptyState={<span className="text-muted-foreground">No sessions yet</span>}
    />
  );
}
