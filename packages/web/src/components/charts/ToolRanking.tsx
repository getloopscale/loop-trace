import { useState } from "react";
import { Link } from "react-router-dom";
import { DataTable, type DataTableColumn } from "@getloopscale/ui";
import type { ToolStat } from "../../api/types.js";
import { EmptyState } from "../primitives/States.js";

type SortKey = "callCount" | "errorRate" | "p95Ms";

const columns: DataTableColumn<ToolStat>[] = [
  {
    key: "toolName",
    label: "Tool",
    render: (t) => (
      <Link to={`/tools/${encodeURIComponent(t.toolName)}`} className="text-primary">
        {t.toolName}
      </Link>
    ),
  },
  { key: "callCount", label: "Calls", sortable: true, align: "right", render: (t) => t.callCount },
  {
    key: "errorRate",
    label: "Error rate",
    sortable: true,
    align: "right",
    render: (t) => `${(t.errorRate * 100).toFixed(1)}%`,
  },
  { key: "p50Ms", label: "p50 (ms)", align: "right", render: (t) => `${t.p50Ms} ms` },
  { key: "p95Ms", label: "p95 (ms)", sortable: true, align: "right", render: (t) => `${t.p95Ms} ms` },
];

/**
 * Sortable per-tool ranking table (M6 DoD #2) — dark DataTable. Sort is controlled:
 * the active column always ranks descending (highest first), matching the original
 * "ranked by X (descending)" semantics; aria-sort reflects the active column.
 */
export function ToolRanking({ tools }: { tools: ToolStat[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("callCount");
  if (tools.length === 0) {
    return <EmptyState message="No tool calls yet" />;
  }
  const sorted = [...tools].sort((a, b) => b[sortKey] - a[sortKey]);
  return (
    <DataTable
      data={sorted}
      columns={columns}
      rowKey={(t) => t.toolName}
      stickyHeader
      sort={{ key: sortKey, direction: "desc" }}
      onSortChange={(s) => {
        if (s) setSortKey(s.key as SortKey);
      }}
    />
  );
}
