import { useTraceList } from "../hooks/useTraces.js";
import { TraceList } from "../components/TraceList.js";
import { Loading, ErrorState } from "../components/states.js";

/** Landing page: lists executions (M3 DoD #1) with loading/error states. */
export function TraceListPage() {
  const { data, isLoading, isError } = useTraceList();
  if (isLoading) return <Loading label="Loading executions…" />;
  if (isError || !data) return <ErrorState message="Failed to load executions" />;
  return (
    <main className="trace-list-page">
      <h1>Executions</h1>
      <TraceList traces={data.traces} />
    </main>
  );
}
