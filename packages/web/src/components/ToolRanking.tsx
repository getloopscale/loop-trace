import { useState } from "react";
import { Link } from "react-router-dom";
import type { ToolStat } from "../api/types.js";
import { EmptyState } from "./states.js";

type SortKey = "callCount" | "errorRate" | "p95Ms";

/** Sortable per-tool ranking table (M6 DoD #2). Each row links to its drill-down. */
export function ToolRanking({ tools }: { tools: ToolStat[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("callCount");
  if (tools.length === 0) {
    return <EmptyState message="No tool calls yet" />;
  }
  const sorted = [...tools].sort((a, b) => b[sortKey] - a[sortKey]);
  const sortBtn = (key: SortKey, label: string) => (
    <button
      type="button"
      className="tool-sort"
      aria-pressed={sortKey === key}
      onClick={() => setSortKey(key)}
    >
      {label}
    </button>
  );
  return (
    <table className="tool-table">
      <caption className="cost-table-caption">Tools ranked by {sortKey}</caption>
      <thead>
        <tr>
          <th scope="col">Tool</th>
          <th scope="col">{sortBtn("callCount", "Calls")}</th>
          <th scope="col">{sortBtn("errorRate", "Error rate")}</th>
          <th scope="col">p50</th>
          <th scope="col">{sortBtn("p95Ms", "p95")}</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((t) => (
          <tr key={t.toolName}>
            <td>
              <Link to={`/tools/${encodeURIComponent(t.toolName)}`}>{t.toolName}</Link>
            </td>
            <td>{t.callCount}</td>
            <td>{(t.errorRate * 100).toFixed(1)}%</td>
            <td>{t.p50Ms} ms</td>
            <td>{t.p95Ms} ms</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
