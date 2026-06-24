import { useState } from "react";
import type { ListTracesQuery } from "../api/types.js";
import {
  listViews,
  saveView,
  deleteView,
  type SavedView,
} from "../lib/saved-views.js";

/**
 * Saved-view selector (M29b) — pick a saved executions-filter view (applies its
 * query), save the current filters under a name, or delete a view. Persistence is
 * the `saved-views` localStorage util; time is global (not part of a view). Token-
 * styled, labelled for a11y. No raw hex.
 */
const fieldCls =
  "rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
const labelCls = "flex flex-col gap-1 text-xs text-muted-foreground";
const btnCls =
  "rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";

export function SavedViewSelector({
  query,
  onApply,
}: {
  query: ListTracesQuery;
  onApply: (query: ListTracesQuery) => void;
}) {
  const [views, setViews] = useState<SavedView[]>(listViews);
  const [selected, setSelected] = useState("");
  const [name, setName] = useState("");

  function applyByName(viewName: string): void {
    setSelected(viewName);
    const v = views.find((x) => x.name === viewName);
    if (v) onApply({ ...v.query });
  }
  function save(): void {
    const next = saveView(name, query);
    setViews(next);
    setName("");
  }
  function removeSelected(): void {
    if (!selected) return;
    setViews(deleteView(selected));
    setSelected("");
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className={labelCls}>
        <span>Saved view</span>
        <select
          aria-label="saved views"
          value={selected}
          onChange={(e) => applyByName(e.target.value)}
          className={fieldCls}
        >
          <option value="">Apply a saved view…</option>
          {views.map((v) => (
            <option key={v.name} value={v.name}>
              {v.name}
            </option>
          ))}
        </select>
      </label>
      <label className={labelCls}>
        <span>Save current as</span>
        <input
          type="text"
          aria-label="view name"
          placeholder="view name…"
          value={name}
          maxLength={48}
          onChange={(e) => setName(e.target.value)}
          className={fieldCls}
        />
      </label>
      <button
        type="button"
        className={btnCls}
        onClick={save}
        disabled={name.trim().length === 0}
      >
        Save view
      </button>
      <button
        type="button"
        className={btnCls}
        onClick={removeSelected}
        disabled={selected.length === 0}
        aria-label="delete selected view"
      >
        Delete
      </button>
    </div>
  );
}
