import { useMemo, useState } from "react";
import type { DataTableSort } from "@theokit/ui";
import { useTraceList } from "../hooks/useTraces.js";
import { useRange, rangeToWindow } from "../hooks/useRange.js";
import { TraceTable } from "../components/TraceTable.js";
import { TraceFilters } from "../components/TraceFilters.js";
import { SavedViewSelector } from "../components/SavedViewSelector.js";
import { TraceSummaryStrip } from "../components/TraceSummaryStrip.js";
import { AutoRefreshControl } from "../components/AutoRefreshControl.js";
import { ErrorState } from "../components/states.js";
import type { ListTracesQuery } from "../api/types.js";

/** Map the M9 query sort ↔ the DataTable controlled sort (start column = recency). */
function queryToTableSort(query: ListTracesQuery): DataTableSort | null {
  if (query.orderBy == null) return null;
  return {
    key: query.orderBy === "recent" ? "start" : query.orderBy,
    direction: query.dir ?? "desc",
  };
}
function tableSortToQuery(
  query: ListTracesQuery,
  sort: DataTableSort | null,
): ListTracesQuery {
  if (sort == null) {
    const next = { ...query };
    delete next.orderBy;
    delete next.dir;
    return next;
  }
  const orderBy = (sort.key === "start" ? "recent" : sort.key) as
    | "recent"
    | "latency"
    | "tokens"
    | "cost";
  return { ...query, orderBy, dir: sort.direction };
}

/**
 * Landing page (M18): the Arize-style dense executions table. A 24h summary strip
 * (TraceSummaryStrip) tops the page; the M9 filter/sort/export toolbar
 * (TraceFilters) is preserved; the list itself is now a sortable DataTable with
 * kind badges + enriched columns (model/cost/input/output). The M16 auto-refresh
 * control stays in the header.
 *
 * The DataTable sortable headers and the M9 sort buttons are both bound to the
 * single `query` state, so they stay in sync. A free-text search box is deferred
 * to M24 (full-text search) where it gains real meaning.
 */
export function TraceListPage() {
  const [query, setQuery] = useState<ListTracesQuery>({});
  // Time is the global date-range (M29b): map the preset → from/to, recomputed only
  // when the range changes (a stable window per selection — auto-refresh handles freshness;
  // recomputing every render would churn the react-query key).
  const { range } = useRange();
  const window = useMemo(() => rangeToWindow(range, Date.now()), [range]);
  const effectiveQuery = useMemo(
    () => ({ ...query, from: window.from, to: window.to }),
    [query, window],
  );
  const { data, isError, dataUpdatedAt } = useTraceList(effectiveQuery);
  return (
    <div className="trace-list-page flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <h1 className="text-display-md font-display">Executions</h1>
        <AutoRefreshControl dataUpdatedAt={dataUpdatedAt} />
      </header>
      <TraceSummaryStrip />
      <TraceFilters query={query} onChange={setQuery} />
      <SavedViewSelector query={query} onApply={setQuery} />
      {/* Prefer showing data (even stale, via keepPreviousData) over an error, so a
          transient refetch failure does not wipe a populated list (review F-fe-6). */}
      {isError && !data ? (
        <ErrorState message="Failed to load executions" />
      ) : (
        <TraceTable
          traces={data?.traces ?? []}
          sort={queryToTableSort(query)}
          onSortChange={(sort) => setQuery(tableSortToQuery(query, sort))}
          loading={!data && !isError}
        />
      )}
    </div>
  );
}
