import { useState } from "react";
import { Link } from "react-router-dom";
import { useTraceList } from "../hooks/useTraces.js";
import { TraceList } from "../components/TraceList.js";
import { TraceFilters } from "../components/TraceFilters.js";
import { Loading, ErrorState } from "../components/states.js";
import type { ListTracesQuery } from "../api/types.js";

/**
 * Landing page: lists executions (M3) with M9 filter/sort/export. The filter
 * toolbar stays mounted across loading/error so a filter change never makes the
 * controls vanish; only the list body swaps state.
 */
export function TraceListPage() {
  const [query, setQuery] = useState<ListTracesQuery>({});
  const { data, isLoading, isError } = useTraceList(query);
  return (
    <main className="trace-list-page">
      <header className="list-header">
        <h1>Executions</h1>
        <Link to="/analytics">Cost analytics →</Link>
        <Link to="/metrics">North-star metrics →</Link>
      </header>
      <TraceFilters query={query} onChange={setQuery} />
      {isLoading ? (
        <Loading label="Loading executions…" />
      ) : isError || !data ? (
        <ErrorState message="Failed to load executions" />
      ) : (
        <TraceList traces={data.traces} />
      )}
    </main>
  );
}
