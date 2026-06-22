import { Link } from "react-router-dom";
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
      <header className="list-header">
        <h1>Executions</h1>
        <Link to="/analytics">Cost analytics →</Link>
        <Link to="/metrics">North-star metrics →</Link>
      </header>
      <TraceList traces={data.traces} />
    </main>
  );
}
