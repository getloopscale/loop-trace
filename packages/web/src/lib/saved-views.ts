import type { ListTracesQuery } from "../api/types.js";

/**
 * Saved executions-filter views (M29b) — named `ListTracesQuery` subsets persisted
 * in localStorage. Time is NOT saved (it is the global date-range picker, M29b ADR-3),
 * so a view captures filter intent (status / model / tag / search / sort), never an
 * absolute window. Every storage access is defensively guarded (private mode /
 * disabled / corrupt JSON → `[]`, never throws — mirrors `useAutoRefresh`).
 */
export interface SavedView {
  name: string;
  query: ListTracesQuery;
}

const STORAGE_KEY = "theolens.savedViews";

/** Drop the time window — it is owned by the global range, not by a saved view. */
function stripTime(query: ListTracesQuery): ListTracesQuery {
  const next = { ...query };
  delete next.from;
  delete next.to;
  return next;
}

function isView(v: unknown): v is SavedView {
  return (
    v != null &&
    typeof v === "object" &&
    typeof (v as { name?: unknown }).name === "string" &&
    (v as { name: string }).name.length > 0 &&
    typeof (v as { query?: unknown }).query === "object" &&
    (v as { query?: unknown }).query != null
  );
}

/** All saved views; `[]` on any storage/parse failure (never throws). */
export function listViews(): SavedView[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw == null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter(isView) : [];
}

function writeAll(views: SavedView[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
  } catch {
    /* storage disabled / quota — caller keeps the returned in-memory list */
  }
}

/**
 * Save the current filters under `name` (time stripped). A blank name is a no-op;
 * an existing name is REPLACED (upsert — no duplicates). Returns the new list.
 */
export function saveView(name: string, query: ListTracesQuery): SavedView[] {
  const trimmed = name.trim();
  if (trimmed.length === 0) return listViews();
  const views = listViews().filter((v) => v.name !== trimmed);
  views.push({ name: trimmed, query: stripTime(query) });
  writeAll(views);
  return views;
}

/** Delete a view by name; returns the new list. */
export function deleteView(name: string): SavedView[] {
  const views = listViews().filter((v) => v.name !== name);
  writeAll(views);
  return views;
}
