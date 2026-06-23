import { useEffect, useMemo, useRef } from "react";
import { Link, useParams } from "react-router-dom";
import { useTraceTree } from "../hooks/useTraces.js";
import { useReplay } from "../hooks/useReplay.js";
import { useTraceCost } from "../hooks/useCost.js";
import { buildReplaySteps } from "../lib/replay.js";
import { formatUsd } from "../lib/money.js";
import { ApiError, recordReplaySession } from "../api/client.js";
import { SpanTree } from "../components/SpanTree.js";
import { SpanInfoPanel } from "../components/SpanInfoPanel.js";
import { SpanIOPanel } from "../components/SpanIOPanel.js";
import { TraceTags } from "../components/TraceTags.js";
import { ReplayControls } from "../components/ReplayControls.js";
import { Loading, ErrorState } from "../components/states.js";

/**
 * Trace view + Session Replay (M4). The replay step index IS the selection: the
 * active span (`steps[index]`) drives `<SpanTree selectedId>`; `next`/`prev`
 * (buttons + ArrowRight/Left) walk the deterministic order; clicking a span jumps
 * the step. Replay is computed from the already-fetched tree — no re-execution.
 */
export function TracePage() {
  const { traceId = "" } = useParams();
  const { data, isLoading, isError, error } = useTraceTree(traceId);

  // Hooks run unconditionally (steps is empty until data arrives).
  const steps = useMemo(() => (data ? buildReplaySteps(data) : []), [data]);
  const { index, active, next, prev, jumpTo } = useReplay(steps);
  // Per-trace cost is supplementary (M5 DoD #3) — never blocks the tree/replay.
  const { data: cost } = useTraceCost(traceId);

  // Record one replay session per trace open (M8 north-star). The ref guards a
  // single open against React StrictMode's paired effect invoke + same-mount
  // re-renders so it is not double-counted (EC-3). A genuine re-navigation back
  // to the same trace is, by design, a new "open" (a new session). The POST is
  // fire-and-forget + fail-soft (D3).
  const recordedRef = useRef<string | null>(null);
  useEffect(() => {
    if (data && traceId && recordedRef.current !== traceId) {
      recordedRef.current = traceId;
      recordReplaySession(traceId);
    }
  }, [data, traceId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack arrows from text fields, selects, or modifier combos (F-fe-2).
      const t = e.target as HTMLElement | null;
      if (
        t?.isContentEditable ||
        (t != null && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) ||
        e.altKey ||
        e.ctrlKey ||
        e.metaKey
      ) {
        return;
      }
      if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev]);

  if (isLoading) return <Loading label="Loading trace…" />;
  if (isError || !data) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <ErrorState
        message={notFound ? "Trace not found" : "Could not load this trace"}
      />
    );
  }

  return (
    <div className="trace-page">
      {/* Trace→session nav (M13): only when this trace carries a session id;
          ungrouped traces show no link (honest fallback, D3). */}
      {data.sessionId ? (
        <Link
          to={`/sessions/${encodeURIComponent(data.sessionId)}`}
          className="trace-session-link"
        >
          View session →
        </Link>
      ) : null}
      {cost ? (
        <p className="trace-cost">
          Total cost: {formatUsd(cost.costUsd)} · {cost.totalTokens} tokens
        </p>
      ) : null}
      <ReplayControls
        index={index}
        total={steps.length}
        onPrev={prev}
        onNext={next}
        activeName={active?.name}
      />
      <TraceTags traceId={traceId} />
      {/* Arize 3-pane (M19): waterfall tree | info tabs | Input/Output. The
          active span (replay selection, root fallback) drives the center + right. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(260px,1fr)_1.4fr_1.4fr]">
        <SpanTree
          root={data}
          selectedId={active?.spanId}
          onSelect={(span) => jumpTo(span.spanId)}
        />
        <SpanInfoPanel span={active ?? data} />
        <SpanIOPanel span={active ?? data} />
      </div>
    </div>
  );
}
