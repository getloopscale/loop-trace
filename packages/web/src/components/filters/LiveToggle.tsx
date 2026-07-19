import { useAutoRefresh } from "../../hooks/useAutoRefresh.js";

/**
 * Top-bar Live toggle (M31 — Arize live-parity). Flips the global Live mode (M16
 * `useAutoRefresh`): when on, every view fast-polls at `LIVE_MS` and a pulsing dot
 * shows beside the "Live" label. `aria-pressed` carries the state; the meaning is the
 * text label, never colour alone (WCAG 1.4.1). Token-styled, keyboard-operable button.
 */
export function LiveToggle() {
  const { live, setLive } = useAutoRefresh();
  return (
    <button
      type="button"
      aria-pressed={live}
      onClick={() => setLive(!live)}
      className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-sm text-foreground transition-colors hover:bg-muted aria-[pressed=true]:border-success aria-[pressed=true]:text-success focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
    >
      {live ? (
        <span
          data-testid="live-pulse"
          aria-hidden="true"
          className="inline-block h-2 w-2 animate-pulse rounded-full bg-success"
        />
      ) : (
        <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-muted-foreground" />
      )}
      Live
    </button>
  );
}
