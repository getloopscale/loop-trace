import type { ListTracesQuery } from "../api/types.js";
import { tracesExportHref } from "../api/client.js";

type OrderBy = NonNullable<ListTracesQuery["orderBy"]>;

const SORT_COLUMNS: { key: OrderBy; label: string }[] = [
  { key: "recent", label: "Recent" },
  { key: "latency", label: "Latency" },
  { key: "tokens", label: "Tokens" },
  { key: "cost", label: "Cost" },
];

/**
 * Executions-list toolbar (M9): status + model filters, sortable column headers
 * (carrying `aria-sort`), and a CSV export of the current filtered set. A fixed
 * whitelist — NOT a query DSL (D1).
 */
export function TraceFilters({
  query,
  onChange,
}: {
  query: ListTracesQuery;
  onChange: (next: ListTracesQuery) => void;
}) {
  const orderBy: OrderBy = query.orderBy ?? "recent";
  const dir = query.dir ?? "desc";

  const toggleSort = (key: OrderBy) => {
    if (key === orderBy) {
      onChange({ ...query, orderBy: key, dir: dir === "desc" ? "asc" : "desc" });
    } else {
      onChange({ ...query, orderBy: key, dir: "desc" });
    }
  };

  return (
    <div className="trace-filters">
      <div className="trace-filter-controls">
        <label>
          Status
          <select
            aria-label="status filter"
            value={query.status ?? ""}
            onChange={(e) => {
              // exactOptionalPropertyTypes: omit the key rather than set undefined.
              const next: ListTracesQuery = { ...query };
              const v = e.target.value;
              if (v === "ok" || v === "error") next.status = v;
              else delete next.status;
              onChange(next);
            }}
          >
            <option value="">All</option>
            <option value="ok">OK</option>
            <option value="error">Error</option>
          </select>
        </label>
        <label>
          Model
          <input
            type="text"
            aria-label="model filter"
            placeholder="e.g. gpt-4o"
            value={query.model ?? ""}
            onChange={(e) => {
              const next: ListTracesQuery = { ...query };
              if (e.target.value) next.model = e.target.value;
              else delete next.model;
              onChange(next);
            }}
          />
        </label>
        <a className="trace-export" href={tracesExportHref(query)} download>
          Export CSV
        </a>
      </div>
      <div className="trace-sort" role="row" aria-label="sort by">
        {SORT_COLUMNS.map(({ key, label }) => {
          const active = key === orderBy;
          return (
            <button
              key={key}
              type="button"
              role="columnheader"
              aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
              aria-pressed={active}
              onClick={() => toggleSort(key)}
            >
              {label}
              {active ? (dir === "asc" ? " ▲" : " ▼") : ""}
            </button>
          );
        })}
      </div>
    </div>
  );
}
