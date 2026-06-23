import { useState } from "react";
import { useTraceList } from "../hooks/useTraces.js";
import { TraceList } from "../components/TraceList.js";
import { TraceFilters } from "../components/TraceFilters.js";
import { AutoRefreshControl } from "../components/AutoRefreshControl.js";
import { Loading, ErrorState } from "../components/states.js";
import type { ListTracesQuery } from "../api/types.js";

/**
 * Landing page: lists executions (M3) with M9 filter/sort/export. The filter
 * toolbar stays mounted across loading/error so a filter change never makes the
 * controls vanish; only the list body swaps state.
 */
export function TraceListPage() {
  const [query, setQuery] = useState<ListTracesQuery>({});
  const { data, isError, dataUpdatedAt } = useTraceList(query);
  return (
    <div className="trace-list-page">
      <header className="list-header">
        <h1 className="text-display-md font-display">Executions</h1>
        <AutoRefreshControl dataUpdatedAt={dataUpdatedAt} />
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
    </div>
  );
}
