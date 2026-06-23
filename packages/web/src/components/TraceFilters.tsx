import { useEffect, useRef, useState } from "react";
import type { ListTracesQuery } from "../api/types.js";
import { tracesExportHref } from "../api/client.js";

type OrderBy = NonNullable<ListTracesQuery["orderBy"]>;

const SORT_COLUMNS: { key: OrderBy; label: string }[] = [
  { key: "recent", label: "Recent" },
  { key: "latency", label: "Latency" },
  { key: "tokens", label: "Tokens" },
  { key: "cost", label: "Cost" },
];

/** A `datetime-local` value → ISO-with-offset (the API's validated shape), or undefined. */
function toIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Executions-list toolbar (M9): status + model + time-range filters, a sort
 * control, and a CSV export of the current filtered set. The sort control is a
 * `role="group"` of toggle buttons (aria-pressed) — NOT a grid `columnheader`,
 * because the list renders as a `<ul>`, so `aria-sort` would be invalid ARIA
 * outside a grid (review F-fe-2). A fixed whitelist, never a query DSL (D1).
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

  const setField = (
    key: "status" | "from" | "to",
    value: string | undefined,
  ) => {
    const next: ListTracesQuery = { ...query };
    if (value) next[key] = value as never;
    else delete next[key];
    onChange(next);
  };

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
            onChange={(e) =>
              setField(
                "status",
                e.target.value === "ok" || e.target.value === "error"
                  ? e.target.value
                  : undefined,
              )
            }
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
            value={modelInput}
            onChange={(e) => onModelInput(e.target.value)}
          />
        </label>
        <label>
          From
          <input
            type="datetime-local"
            aria-label="from time"
            onChange={(e) => setField("from", toIso(e.target.value))}
          />
        </label>
        <label>
          To
          <input
            type="datetime-local"
            aria-label="to time"
            onChange={(e) => setField("to", toIso(e.target.value))}
          />
        </label>
        <label>
          Tag
          <input
            type="text"
            aria-label="tag filter"
            placeholder="e.g. prod"
            value={tagInput}
            onChange={(e) => onTagInput(e.target.value)}
          />
        </label>
        <a className="trace-export" href={tracesExportHref(query)} download>
          Export CSV
        </a>
      </div>
      <div className="trace-sort" role="group" aria-label="sort by">
        {SORT_COLUMNS.map(({ key, label }) => {
          const active = key === orderBy;
          return (
            <button
              key={key}
              type="button"
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
