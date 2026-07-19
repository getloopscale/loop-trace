import { DataTable, type DataTableColumn } from "@usetheo/ui";
import type { CostBucket } from "../../api/types.js";
import { formatUsd } from "../../lib/money.js";
import { EmptyState } from "../primitives/States.js";

const columns: DataTableColumn<CostBucket>[] = [
  { key: "periodStart", label: "Period", render: (b) => b.periodStart.slice(0, 10) },
  { key: "costUsd", label: "Cost", align: "right", render: (b) => formatUsd(b.costUsd) },
  { key: "totalTokens", label: "Tokens", align: "right", render: (b) => b.totalTokens },
  { key: "traceCount", label: "Executions", align: "right", render: (b) => b.traceCount },
];

/** Period (day/week) cost aggregation table (M5 DoD #2) — dark DataTable. */
export function CostByPeriod({ buckets }: { buckets: CostBucket[] }) {
  if (buckets.length === 0) {
    return <EmptyState message="No cost data yet" />;
  }
  return (
    <DataTable
      data={buckets}
      columns={columns}
      rowKey={(b) => b.periodStart}
      stickyHeader
    />
  );
}
