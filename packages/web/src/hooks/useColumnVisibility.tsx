import { useState } from "react";

/**
 * Persisted executions-table column visibility (M29d). Stores the set of HIDDEN
 * column keys in localStorage; absent = visible (default: every column visible).
 * Mirrors the defensive read/write of `useRange` / `saved-views` — a disabled,
 * private-mode, or corrupt store falls back to "all visible" and NEVER crashes
 * (and never an all-hidden table). The `name` column is never offered for hiding
 * by `ColumnToggle`, so it cannot be persisted hidden.
 */
const STORAGE_KEY = "theolens.columnVisibility";

/** Read the persisted hidden-column keys; defensive on every axis → `[]` on any failure. */
export function readHiddenColumns(): string[] {
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw == null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((k): k is string => typeof k === "string");
  } catch {
    return [];
  }
}

function writeHiddenColumns(keys: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch {
    /* storage disabled / quota — in-memory state still holds */
  }
}

export function useColumnVisibility(): {
  hidden: Set<string>;
  toggle: (key: string) => void;
} {
  const [hidden, setHidden] = useState<Set<string>>(
    () => new Set(readHiddenColumns()),
  );
  function toggle(key: string): void {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeHiddenColumns([...next]);
      return next;
    });
  }
  return { hidden, toggle };
}
