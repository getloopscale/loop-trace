import { useState } from "react";
import { Plus } from "lucide-react";
import { useDatasets } from "../hooks/useDatasets.js";

/**
 * Per-executions-row "Add to Dataset" control (M26d D5): a small popover to pick an
 * existing dataset OR type a new name → add the trace (create-or-get then add-item).
 * `stopPropagation` so a click never expands the row's inline span-tree. No modal
 * framework — KISS. Reflects a transient "Added ✓" after a successful write.
 */
export function AddToDataset({ traceId }: { traceId: string }) {
  const { query, create, addItem } = useDatasets();
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [newName, setNewName] = useState("");
  const [added, setAdded] = useState(false);
  const [failed, setFailed] = useState(false);

  const datasets = query.data?.datasets ?? [];
  const canAdd = newName.trim().length > 0 || selectedId.length > 0;

  const stop = (e: React.MouseEvent) => e.stopPropagation();

  const onAdd = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canAdd) return;
    setFailed(false);
    try {
      // Fail-clear (Rule 8): a rejected create/add MUST surface, never an unhandled
      // promise rejection that silently leaves the popover open with no feedback.
      const trimmed = newName.trim();
      const datasetId =
        trimmed.length > 0 ? (await create.mutateAsync(trimmed)).id : selectedId;
      await addItem.mutateAsync({ datasetId, traceId });
      setAdded(true);
      setOpen(false);
      setNewName("");
      setSelectedId("");
    } catch {
      setFailed(true);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        aria-label={`add trace ${traceId} to a dataset`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Plus className="size-3" aria-hidden />
        {added ? "Added" : "Dataset"}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-1" onClick={stop}>
      <select
        aria-label="choose a dataset"
        value={selectedId}
        onChange={(e) => setSelectedId(e.target.value)}
        className="rounded border border-border bg-background px-1 py-0.5 text-xs text-foreground"
      >
        <option value="">— pick —</option>
        {datasets.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
      <input
        type="text"
        aria-label="new dataset name"
        placeholder="or new name"
        value={newName}
        maxLength={120}
        onChange={(e) => setNewName(e.target.value)}
        className="w-24 rounded border border-border bg-background px-1 py-0.5 text-xs text-foreground placeholder:text-muted-foreground"
      />
      <button
        type="button"
        aria-label="confirm add to dataset"
        disabled={!canAdd}
        onClick={onAdd}
        className="rounded border border-border px-2 py-0.5 text-xs text-foreground transition-colors hover:bg-muted disabled:opacity-50"
      >
        Add
      </button>
      {failed ? (
        <span role="alert" className="text-xs text-destructive">
          failed
        </span>
      ) : null}
    </span>
  );
}
