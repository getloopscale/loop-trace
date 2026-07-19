import { useParams } from "react-router-dom";
import { StatTile } from "@usetheo/ui";
import { Activity, AlertTriangle, Clock, Coins, DollarSign } from "lucide-react";
import { useSessionDetail } from "../hooks/useSessions.js";
import { TraceTable } from "../components/trace/TraceTable.js";
import { Loading, ErrorState } from "../components/primitives/States.js";
import { formatUsd } from "../lib/money.js";
import { formatDuration } from "../lib/duration.js";
import { formatPercent } from "../lib/percent.js";
import { formatDateTime } from "../lib/datetime.js";

/**
 * Session view (M13): session-scoped metrics as a StatTile grid + the member
 * execution list (dark DataTable). Loading/error states mirror the rest of the
 * app; an absent session surfaces the API 404 as a "not found" error.
 */
export function SessionDetailPage() {
  const { sessionId = "" } = useParams();
  const { data, isLoading, isError } = useSessionDetail(sessionId);

  if (isLoading) return <Loading label="Loading session…" />;
  if (isError || !data) return <ErrorState message="Session not found" />;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-title-lg font-display">Session {data.sessionId}</h1>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
        <StatTile value={data.traceCount} label="Traces" icon={Activity} />
        <StatTile value={formatUsd(data.costUsd)} label="Cost" icon={DollarSign} />
        <StatTile value={data.totalTokens} label="Tokens" icon={Coins} />
        <StatTile
          value={formatPercent(data.errorRate)}
          label="Error rate"
          icon={AlertTriangle}
        />
        <StatTile
          value={formatDuration(data.latencyP50Ms)}
          label="Latency p50"
          icon={Clock}
        />
        <StatTile
          value={formatDuration(data.latencyP95Ms)}
          label="Latency p95"
          icon={Clock}
        />
        <StatTile
          value={formatDateTime(data.lastSeenAt)}
          label="Last seen"
          icon={Clock}
        />
      </div>
      <h2 className="text-title-md font-display">Traces in this session</h2>
      <TraceTable traces={data.traces} sort={null} onSortChange={() => {}} />
    </div>
  );
}
