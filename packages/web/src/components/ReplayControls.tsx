/** Step navigation for Session Replay (M4): counter + prev/next, disabled at bounds. */
export interface ReplayControlsProps {
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  /** Name of the active span, announced with the step for screen readers. */
  activeName?: string | undefined;
}

export function ReplayControls({
  index,
  total,
  onPrev,
  onNext,
  activeName,
}: ReplayControlsProps) {
  return (
    <div
      className="my-3 flex items-center gap-3"
      role="group"
      aria-label="replay controls"
    >
      <button
        type="button"
        className="rounded-md border border-border bg-background px-2.5 py-1 text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
        onClick={onPrev}
        disabled={index <= 0}
        aria-label="previous step"
      >
        <span aria-hidden="true">◀</span>
      </button>
      {/* role=status (implies aria-live=polite) announces each step to screen readers. */}
      <span className="text-sm tabular-nums text-muted-foreground" role="status">
        Step {index + 1} of {total}
        {activeName ? ` — ${activeName}` : ""}
      </span>
      <button
        type="button"
        className="rounded-md border border-border bg-background px-2.5 py-1 text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
        onClick={onNext}
        disabled={index >= total - 1}
        aria-label="next step"
      >
        <span aria-hidden="true">▶</span>
      </button>
    </div>
  );
}
