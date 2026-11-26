import { useState } from "react";
import { Link } from "react-router-dom";
import { DataTable, Timestamp, type DataTableColumn } from "@getloopscale/ui";
import { useDatasets } from "../hooks/useDatasets.js";
import { Loading, ErrorState, EmptyState } from "../components/primitives/States.js";
import type { Dataset } from "../api/types.js";

const DASH = "—";

function isoToMs(iso: string): number | undefined {
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

const columns: DataTableColumn<Dataset>[] = [
  {
    key: "name",
    label: "Name",
    render: (d) => (
      <Link to={`/datasets/${encodeURIComponent(d.id)}`} className="text-primary">
        {d.name}
      </Link>
    ),
  },
  { key: "items", label: "Items", align: "right", render: (d) => d.itemCount },
  {
    key: "created",
    label: "Created",
    render: (d) => {
      const ms = isoToMs(d.createdAt);
      return ms == null ? DASH : <Timestamp value={ms} format="relative" />;
    },
  },
];

/**
 * Datasets list (M26d): curated example sets. A create form + a table of datasets
 * (name → detail, item count, created). Mirrors SessionsListPage; loading/error/empty.
 */
export function DatasetsListPage() {
  const { query, create } = useDatasets();
  const [name, setName] = useState("");

  const onCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (n.length === 0) return;
    create.mutate(n, { onSuccess: () => setName("") });
  };

  return (
    <div className="datasets-list-page flex flex-col gap-4">
      <h1 className="text-display-md font-display">Datasets</h1>

      <form onSubmit={onCreate} className="flex gap-2">
        <input
          type="text"
          aria-label="new dataset name"
          placeholder="new dataset name"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        />
        <button
          type="submit"
          disabled={name.trim().length === 0}
          className="rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
        >
          Create dataset
        </button>
      </form>

      {query.isLoading ? (
        <Loading label="Loading datasets…" />
      ) : query.isError || !query.data ? (
        <ErrorState message="Failed to load datasets" />
      ) : query.data.datasets.length === 0 ? (
        <EmptyState message="No datasets yet — create one above, or use “Add to Dataset” on any execution row." />
      ) : (
        <DataTable
          data={query.data.datasets}
          columns={columns}
          rowKey={(d) => d.id}
          emptyState={<span className="text-muted-foreground">No datasets yet</span>}
        />
      )}
    </div>
  );
}
