import { useEffect, useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useTraceTree } from "../hooks/useTraces.js";
import { useReplay } from "../hooks/useReplay.js";
import { buildReplaySteps } from "../lib/replay.js";
import { ApiError } from "../api/client.js";
import { SpanTree } from "../components/SpanTree.js";
import { SpanDetail } from "../components/SpanDetail.js";
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
    <main className="trace-page">
      <Link to="/">← Executions</Link>
      <ReplayControls
        index={index}
        total={steps.length}
        onPrev={prev}
        onNext={next}
      />
      <div className="trace-layout">
        <SpanTree
          root={data}
          selectedId={active?.spanId}
          onSelect={(span) => jumpTo(span.spanId)}
        />
        <SpanDetail span={active ?? data} />
      </div>
    </main>
  );
}
