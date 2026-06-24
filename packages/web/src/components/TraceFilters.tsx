import { useEffect, useRef, useState } from "react";
import type { ListTracesQuery } from "../api/types.js";
import { tracesExportHref } from "../api/client.js";

/**
 * Executions-list toolbar (M9; sort moved to the M18 DataTable headers): status +
 * model + time-range + tag filters, and a CSV export of the current filtered set.
 * A fixed whitelist, never a query DSL (D1). Sorting is now owned by the sortable
 * DataTable column headers (M18) — both write the same `orderBy`/`dir` query state.
 */
export function TraceFilters({
  query,
  onChange,
}: {
  query: ListTracesQuery;
  onChange: (next: ListTracesQuery) => void;
}) {
  // Debounce the model input so typing does not fire a request per keystroke (F-fe-9).
  const [modelInput, setModelInput] = useState(query.model ?? "");
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => setModelInput(query.model ?? ""), [query.model]);
  const onModelInput = (value: string) => {
    setModelInput(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const next: ListTracesQuery = { ...query };
      if (value) next.model = value;
      else delete next.model;
      onChange(next);
    }, 300);
  };

  // M14: a tag filter, debounced like the model input (own timer so the two
  // debounces don't clobber each other).
  const [tagInput, setTagInput] = useState(query.tag ?? "");
  const tagTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => setTagInput(query.tag ?? ""), [query.tag]);
  const onTagInput = (value: string) => {
    setTagInput(value);
    if (tagTimer.current) clearTimeout(tagTimer.current);
    tagTimer.current = setTimeout(() => {
      const next: ListTracesQuery = { ...query };
      if (value) next.tag = value;
      else delete next.tag;
      onChange(next);
    }, 300);
  };

  // M24: full-text search over span input/output, debounced like model/tag (own timer).
  const [searchInput, setSearchInput] = useState(query.q ?? "");
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => setSearchInput(query.q ?? ""), [query.q]);
  const onSearchInput = (value: string) => {
    setSearchInput(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      const next: ListTracesQuery = { ...query };
      if (value) next.q = value;
      else delete next.q;
      onChange(next);
    }, 300);
  };

  // Clear any pending debounce on unmount so a late timer never setStates an
  // unmounted component (covers the model/tag/search inputs).
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (tagTimer.current) clearTimeout(tagTimer.current);
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    [],
  );

  const setField = (
    key: "status",
    value: string | undefined,
  ) => {
    const next: ListTracesQuery = { ...query };
    if (value) next[key] = value as never;
    else delete next[key];
    onChange(next);
  };

  // Shared design-token field styling (DRY — presentation only, one source).
  const fieldCls =
    "rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
  const labelCls = "flex flex-col gap-1 text-xs text-muted-foreground";

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className={labelCls}>
        <span>Search</span>
        <input
          type="search"
          aria-label="search content"
          placeholder="Search prompt / response…"
          value={searchInput}
          onChange={(e) => onSearchInput(e.target.value)}
          className={`${fieldCls} min-w-56`}
        />
      </label>
      <label className={labelCls}>
        <span>Status</span>
        <select
          aria-label="status filter"
          value={query.status ?? ""}
          onChange={(e) =>
            setField(
              "status",
              e.target.value === "ok" || e.target.value === "error"
                ? e.target.value
                : undefined,
            )
          }
          className={fieldCls}
        >
          <option value="">All</option>
          <option value="ok">OK</option>
          <option value="error">Error</option>
        </select>
      </label>
      <label className={labelCls}>
        <span>Model</span>
        <input
          type="text"
          aria-label="model filter"
          placeholder="e.g. gpt-4o"
          value={modelInput}
          onChange={(e) => onModelInput(e.target.value)}
          className={fieldCls}
        />
      </label>
      <label className={labelCls}>
        <span>Tag</span>
        <input
          type="text"
          aria-label="tag filter"
          placeholder="e.g. prod"
          value={tagInput}
          onChange={(e) => onTagInput(e.target.value)}
          className={fieldCls}
        />
      </label>
      <a
        className="inline-flex items-center rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        href={tracesExportHref(query)}
        download
      >
        Export CSV
      </a>
    </div>
  );
}
