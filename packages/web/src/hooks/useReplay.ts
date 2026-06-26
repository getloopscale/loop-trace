import { useCallback, useEffect, useRef, useState } from "react";
import type { SpanNodeData } from "../api/types.js";

export interface Replay {
  steps: SpanNodeData[];
  index: number;
  active: SpanNodeData | undefined;
  next: () => void;
  prev: () => void;
  jumpTo: (spanId: string) => void;
}

/**
 * Replay step state (M4 ADR D2): a single step index over the ordered steps.
 * Callbacks are stable (a `stepsRef` keeps `next`/`jumpTo` reading the current
 * steps without re-creating the handlers each render), so a keyboard listener can
 * depend on them safely. `index` is clamped so a shrinking `steps` never overruns.
 */
export function useReplay(steps: SpanNodeData[], initialIndex = 0): Replay {
  const [index, setIndex] = useState(initialIndex);
  const stepsRef = useRef(steps);
  stepsRef.current = steps;

  // A new session (new steps array) restarts replay at the initial step — M35: the
  // first I/O-bearing span (else the root). Without this a stale index would carry
  // over when navigating between traces (review F-fe-3).
  useEffect(() => setIndex(initialIndex), [steps, initialIndex]);

  const next = useCallback(
    () => setIndex((i) => Math.min(i + 1, stepsRef.current.length - 1)),
    [],
  );
  const prev = useCallback(() => setIndex((i) => Math.max(i - 1, 0)), []);
  const jumpTo = useCallback((spanId: string) => {
    const i = stepsRef.current.findIndex((s) => s.spanId === spanId);
    if (i >= 0) setIndex(i);
  }, []);

  const last = Math.max(0, steps.length - 1);
  const safeIndex = Math.min(index, last);
  return { steps, index: safeIndex, active: steps[safeIndex], next, prev, jumpTo };
}
