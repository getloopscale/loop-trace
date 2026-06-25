import { useSpanQuery } from "../hooks/useSpanQuery.js";
import { SpanFilterBar } from "./SpanFilterBar.js";
import { AddFilterBuilder } from "./AddFilterBuilder.js";

/**
 * The shared span-query toolbar (M30b) — the free-text "Filter spans" bar (M30) + the
 * structured "Add Filter" builder, both bound to the SAME global `useSpanQuery` string
 * (D1/D3). Mounted once in the AppShell on project-view tabs (D2), it is the filter
 * spine that drives the executions list and the Agent Graph/Path trace picker.
 */
export function SpanQueryToolbar() {
  const { spanQuery, setSpanQuery } = useSpanQuery();
  return (
    <div className="flex flex-wrap items-end gap-3 px-4 pt-3">
      <SpanFilterBar
        value={spanQuery}
        onChange={(next) => setSpanQuery(next ?? "")}
      />
      <AddFilterBuilder value={spanQuery} onChange={setSpanQuery} />
    </div>
  );
}
