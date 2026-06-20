/** Step navigation for Session Replay (M4): counter + prev/next, disabled at bounds. */
export interface ReplayControlsProps {
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}

export function ReplayControls({
  index,
  total,
  onPrev,
  onNext,
}: ReplayControlsProps) {
  return (
    <div className="replay-controls" role="group" aria-label="replay controls">
      <button
        type="button"
        className="replay-btn"
        onClick={onPrev}
        disabled={index <= 0}
        aria-label="previous step"
      >
        ◀
      </button>
      <span className="replay-counter">
        Step {total === 0 ? 0 : index + 1} of {total}
      </span>
      <button
        type="button"
        className="replay-btn"
        onClick={onNext}
        disabled={index >= total - 1}
        aria-label="next step"
      >
        ▶
      </button>
    </div>
  );
}
