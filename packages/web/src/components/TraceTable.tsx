import { Link } from "react-router-dom";
import {
  Badge,
  DataTable,
  Timestamp,
  type DataTableColumn,
  type DataTableSort,
} from "@theokit/ui";
import type { TraceListItem } from "../api/types.js";
import { deriveTraceListItemKind } from "../lib/span-kind.js";
import { KindBadge } from "./kind-badge.js";
import { TraceRowSpanTree } from "./TraceRowSpanTree.js";
import { ModelPill } from "./ModelPill.js";
import { formatDuration } from "../lib/duration.js";
import { formatUsd } from "../lib/money.js";

/** Trace nano-timestamp → Unix ms (theo-ui Timestamp expects ms), BigInt-safe. */
function nanoToMs(nano: string | undefined): number | undefined {
  if (nano == null) return undefined;
  try {
    return Number(BigInt(nano) / 1_000_000n);
  } catch {
    return undefined;
  }
}

const DASH = "—";

const columns: DataTableColumn<TraceListItem>[] = [
  {
    key: "status",
    label: "Status",
    render: (t) =>
      t.statusCode == null ? (
        <span className="text-muted-foreground">{DASH}</span>
      ) : (
        <Badge
          variant={t.statusCode === "error" ? "destructive" : "success"}
          size="sm"
          aria-label={t.statusCode === "error" ? "status: error" : "status: ok"}
        >
          {t.statusCode === "error" ? "error" : "ok"}
        </Badge>
      ),
  },
  {
    key: "kind",
    label: "Kind",
    render: (t) => <KindBadge kind={deriveTraceListItemKind(t)} />,
  },
  {
    key: "model",
    label: "Model",
    render: (t) => <ModelPill model={t.model} />,
  },
  {
    key: "name",
    label: "Name",
    render: (t) => (
      <Link to={`/traces/${t.traceId}`} className="text-primary">
        {t.name ?? t.traceId}
      </Link>
    ),
  },
  {
    key: "input",
    label: "Input",
    render: (t) => (
      <span
        className="block max-w-[32ch] truncate text-muted-foreground"
        title={t.inputPreview}
      >
        {t.inputPreview ?? DASH}
      </span>
    ),
  },
  {
    key: "output",
    label: "Output",
    render: (t) => (
      <span
        className="block max-w-[32ch] truncate text-muted-foreground"
        title={t.outputPreview}
      >
        {t.outputPreview ?? DASH}
      </span>
    ),
  },
  {
    key: "start",
    label: "Start",
    sortable: true,
    render: (t) => {
      const ms = nanoToMs(t.startTimeUnixNano);
      return ms == null ? DASH : <Timestamp value={ms} format="relative" />;
    },
  },
  {
    key: "end",
    label: "End",
    render: (t) => {
      const ms = nanoToMs(t.endTimeUnixNano);
      return ms == null ? DASH : <Timestamp value={ms} format="relative" />;
    },
  },
  {
    key: "latency",
    label: "Latency",
    align: "right",
    sortable: true,
    render: (t) => (t.durationMs == null ? DASH : formatDuration(t.durationMs)),
  },
  {
    key: "tokens",
    label: "Tokens",
    align: "right",
    sortable: true,
    render: (t) => t.totalTokens ?? DASH,
  },
  {
    key: "cost",
    label: "Cost",
    align: "right",
    sortable: true,
    render: (t) => (t.costUsd == null ? DASH : formatUsd(t.costUsd)),
  },
];

/**
 * Arize-style dense executions table (M18). Built on theo-ui DataTable: sortable
 * (server-controlled), sticky header, expandable row showing the fuller input/
 * output preview. Sort is controlled by the page (mapped to the M9 ListTracesQuery).
 */
export function TraceTable({
  traces,
  sort,
  onSortChange,
  loading,
}: {
  traces: TraceListItem[];
  sort: DataTableSort | null;
  onSortChange: (sort: DataTableSort | null) => void;
  loading?: boolean;
}) {
  return (
    <DataTable
      data={traces}
      columns={columns}
      rowKey={(t) => t.traceId}
      sort={sort}
      onSortChange={onSortChange}
      loading={loading ?? false}
      emptyState={<span className="text-muted-foreground">No executions yet</span>}
      expandable={(t) => <TraceRowSpanTree traceId={t.traceId} />}
    />
  );
}
