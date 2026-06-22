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
  const { data, isError } = useTraceList(query);
  return (
    <main className="trace-list-page">
      <header className="list-header">
        <h1>Executions</h1>
        <Link to="/analytics">Cost analytics →</Link>
        <Link to="/dashboards">Observability →</Link>
        <Link to="/sessions">Sessions →</Link>
        <Link to="/metrics">North-star metrics →</Link>
      </header>
      <TraceFilters query={query} onChange={setQuery} />
      {/* Prefer showing data (even stale, via keepPreviousData) over an error, so a
          transient refetch failure does not wipe a populated list (review F-fe-6). */}
      {data ? (
        <TraceList traces={data.traces} />
      ) : isError ? (
        <ErrorState message="Failed to load executions" />
      ) : (
        <Loading label="Loading executions…" />
      )}
    </main>
  );
}
