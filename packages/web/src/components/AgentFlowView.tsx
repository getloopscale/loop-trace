import { useState } from "react";
import { useTraceList, useTraceTree } from "../hooks/useTraces.js";
import type { TraceTreeNode } from "../api/types.js";
import type { SankeyModel } from "../lib/agent-graph.js";
import type { SpanKind } from "../lib/span-kind.js";
import { SankeyDiagram, kindColorClass } from "./SankeyDiagram.js";
import { TracePicker } from "./TracePicker.js";
import { Loading, ErrorState, EmptyState } from "./states.js";

/** Distinct non-terminal kinds present in the model (for the legend). */
function legendKinds(model: SankeyModel): SpanKind[] {
  const seen = new Set<string>();
  const out: SpanKind[] = [];
  for (const n of model.nodes) {
    if (n.kind === "terminal" || seen.has(n.kind)) continue;
    seen.add(n.kind);
    out.push(n.kind);
  }
  return out;
}

/**
 * Shared scaffold for the two per-trace agent views (M21, DRY): a trace picker
 * (default most-recent) → the selected trace's tree → a `build` derivation →
 * `SankeyDiagram`, with loading/empty/error states. The Agent Path passes a kind
 * legend; the Agent Graph omits it (its nodes are agents, colored by kind).
 */
export function AgentFlowView({
  title,
  ariaLabel,
  build,
  showLegend = false,
  emptyHint,
}: {
  title: string;
  ariaLabel: string;
  build: (tree: TraceTreeNode) => SankeyModel;
  showLegend?: boolean;
  emptyHint: string;
}) {
  const list = useTraceList();
  const traces = list.data?.traces ?? [];
  const [picked, setPicked] = useState("");
  const selectedId = picked || traces[0]?.traceId || "";
  const tree = useTraceTree(selectedId);
  const model = tree.data ? build(tree.data) : null;

  return (
    <div className="agent-flow-view flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-display-md font-display">{title}</h1>
        {traces.length > 0 ? (
          <TracePicker traces={traces} value={selectedId} onChange={setPicked} />
        ) : null}
      </div>

      {list.isLoading ? (
        <Loading label="Loading traces…" />
      ) : list.isError ? (
        <ErrorState message="Failed to load traces" />
      ) : traces.length === 0 ? (
        <EmptyState message={emptyHint} />
      ) : tree.isLoading ? (
        <Loading label="Loading trace…" />
      ) : tree.isError || !model ? (
        <ErrorState message="Failed to load the selected trace" />
      ) : (
        <>
          {showLegend ? (
            <ul className="flex flex-wrap gap-3" aria-label="kind legend">
              {legendKinds(model).map((k) => (
                <li key={k} className="flex items-center gap-1 text-body-sm">
                  <span
                    className={`${kindColorClass(k)} inline-block size-3 rounded-sm`}
                    style={{ backgroundColor: "currentColor" }}
                    aria-hidden
                  />
                  {k}
                </li>
              ))}
            </ul>
          ) : null}
          <SankeyDiagram model={model} ariaLabel={ariaLabel} />
        </>
      )}
    </div>
  );
}
