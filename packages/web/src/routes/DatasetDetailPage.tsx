import { Link, useParams } from "react-router-dom";
import { DataTable, Timestamp, type DataTableColumn } from "@theokit/ui";
import { useDataset } from "../hooks/useDatasets.js";
import { Loading, ErrorState, EmptyState } from "../components/states.js";
import type { DatasetItem } from "../api/types.js";

const DASH = "—";

function isoToMs(iso: string): number | undefined {
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

const columns: DataTableColumn<DatasetItem>[] = [
  {
    key: "trace",
    label: "Trace",
    render: (i) => (
      <Link to={`/traces/${encodeURIComponent(i.traceId)}`} className="text-primary">
        {i.traceId}
      </Link>
    ),
  },
  {
    key: "input",
    label: "Input snapshot",
    render: (i) => (
      <span className="block max-w-[32ch] truncate text-muted-foreground" title={i.inputSnapshot}>
        {i.inputSnapshot ?? DASH}
      </span>
    ),
  },
  {
    key: "output",
    label: "Output snapshot",
    render: (i) => (
      <span className="block max-w-[32ch] truncate text-muted-foreground" title={i.outputSnapshot}>
        {i.outputSnapshot ?? DASH}
      </span>
    ),
  },
  {
    key: "added",
    label: "Added",
    render: (i) => {
      const ms = isoToMs(i.createdAt);
      return ms == null ? DASH : <Timestamp value={ms} format="relative" />;
    },
  },
];

/**
 * Dataset detail (M26d): a dataset's curated items — each the source trace + its
 * input/output snapshot captured at add-time (durable past prune). Mirrors SessionDetailPage.
 */
export function DatasetDetailPage() {
  const { datasetId = "" } = useParams();
  const { data, isLoading, isError } = useDataset(datasetId);

  if (isLoading) return <Loading label="Loading dataset…" />;
  if (isError || !data) return <ErrorState message="Failed to load dataset" />;

  return (
    <div className="dataset-detail-page flex flex-col gap-4">
      <h1 className="text-display-md font-display">{data.name}</h1>
      {data.items.length === 0 ? (
        <EmptyState message="No items yet — use “Add to Dataset” on an execution row to add a trace." />
      ) : (
        <DataTable
          data={data.items}
          columns={columns}
          rowKey={(i) => i.traceId}
          emptyState={<span className="text-muted-foreground">No items yet</span>}
        />
      )}
    </div>
  );
}
