/** Async-state primitives shared by every data view (loading / error / empty). */
import type { ReactNode } from "react";
import { Skeleton } from "@theokit/ui";

/**
 * Loading placeholder: a shimmer Skeleton block (FAANG-grade — no "Loading…"
 * text flash) that still exposes `role=status` + a visually-hidden label so
 * screen readers announce the loading state (a11y preserved).
 */
export function Loading({
  label = "Loading…",
  rows = 3,
}: {
  label?: string;
  rows?: number;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      data-testid="loading"
      className="flex w-full flex-col gap-2"
    >
      <span className="sr-only">{label}</span>
      {/* Skeletons are decorative — the wrapper's role=status + sr-only label is
          the single a11y source; aria-hidden keeps each Skeleton's own role=status
          out of the accessibility tree (no duplicate status regions). */}
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} aria-hidden className="h-4 w-full" />
      ))}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
    >
      {message}
    </div>
  );
}

/**
 * Empty result. Optional `action` slot renders a CTA (e.g. a navigation button)
 * below the message — FAANG empty states guide the user rather than dead-ending.
 * The deferred a11y note (no extra live region, to avoid colliding with
 * ReplayControls' role=status) still stands: this stays role-less.
 */
export function EmptyState({
  message,
  action,
}: {
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-8 text-sm text-muted-foreground">
      <span className="italic">{message}</span>
      {action}
    </div>
  );
}
