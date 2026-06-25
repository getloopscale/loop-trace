import { useMemo, useState } from "react";
import type { DataTableSort } from "@theokit/ui";
import { useTraceList } from "../hooks/useTraces.js";
import { useRange, rangeToWindow } from "../hooks/useRange.js";
import { TraceTable, TOGGLEABLE_COLUMNS } from "../components/TraceTable.js";
import { TraceFilters } from "../components/TraceFilters.js";
import { ColumnToggle } from "../components/ColumnToggle.js";
import { SavedViewSelector } from "../components/SavedViewSelector.js";
import { useColumnVisibility } from "../hooks/useColumnVisibility.js";
import { useSpanQuery } from "../hooks/useSpanQuery.js";
import { useAutoRefresh } from "../hooks/useAutoRefresh.js";
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
  // M30b: the span-query is now the global shared spine (the bar lives in the AppShell
  // toolbar, driving every project-view tab) — read it here and merge into the query.
  const { spanQuery } = useSpanQuery();
  // M31: in Live mode the upper time bound is OPEN (omit `to`) so traces ingested
  // after page-load — the whole point of "Live" — appear on the next poll. The frozen
  // window's `to` (M29b, memoized on [range]) would otherwise hide anything newer than
  // load time. Off → keep the stable [from,to] window (M29b behaviour intact).
  const { live } = useAutoRefresh();
  const window = useMemo(() => rangeToWindow(range, Date.now()), [range]);
  const effectiveQuery = useMemo(
    () => ({
      ...query,
      from: window.from,
      ...(live ? {} : { to: window.to }),
      ...(spanQuery ? { spanQuery } : {}),
    }),
    [query, window, spanQuery, live],
  );
  const { data, isError, dataUpdatedAt } = useTraceList(effectiveQuery);
  const { hidden, toggle } = useColumnVisibility();
  return (
    <div className="trace-list-page flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <h1 className="text-display-md font-display">Executions</h1>
        <div className="flex items-center gap-2">
          <ColumnToggle columns={TOGGLEABLE_COLUMNS} hidden={hidden} onToggle={toggle} />
          <AutoRefreshControl dataUpdatedAt={dataUpdatedAt} />
        </div>
      </header>
      <TraceSummaryStrip />
      <TraceFilters query={query} onChange={setQuery} exportQuery={effectiveQuery} />
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
          hiddenColumns={hidden}
        />
      )}
    </div>
  );
}
