import { useParams } from "react-router-dom";
import { useSessionDetail } from "../hooks/useSessions.js";
import { TraceList } from "../components/TraceList.js";
import { Loading, ErrorState } from "../components/states.js";
import { formatUsd } from "../lib/money.js";
import { formatDuration } from "../lib/duration.js";
import { formatPercent } from "../lib/percent.js";
import { formatDateTime } from "../lib/datetime.js";

/**
 * Session view (M13): session-scoped metrics + the member trace list (reuses the
 * M3 TraceList). Loading/error states mirror the rest of the app; an absent
 * session surfaces the API 404 as a "not found" error.
 */
export function SessionDetailPage() {
  const { sessionId = "" } = useParams();
  const { data, isLoading, isError } = useSessionDetail(sessionId);

  if (isLoading) return <Loading label="Loading session…" />;
  if (isError || !data) return <ErrorState message="Session not found" />;

  return (
    <div className="session-detail-page">
      <h1 className="text-title-lg font-display">Session {data.sessionId}</h1>
      <dl className="session-metrics">
        <div><dt>Traces</dt><dd>{data.traceCount}</dd></div>
        <div><dt>Cost</dt><dd>{formatUsd(data.costUsd)}</dd></div>
        <div><dt>Tokens</dt><dd>{data.totalTokens}</dd></div>
        <div><dt>Error rate</dt><dd>{formatPercent(data.errorRate)}</dd></div>
        <div><dt>Latency p50</dt><dd>{formatDuration(data.latencyP50Ms)}</dd></div>
        <div><dt>Latency p95</dt><dd>{formatDuration(data.latencyP95Ms)}</dd></div>
        <div><dt>Last seen</dt><dd>{formatDateTime(data.lastSeenAt)}</dd></div>
      </dl>
      <h2>Traces in this session</h2>
      <TraceList traces={data.traces} />
    </div>
  );
}
