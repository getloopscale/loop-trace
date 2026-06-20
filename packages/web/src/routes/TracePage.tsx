import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTraceTree } from "../hooks/useTraces.js";
import { SpanTree } from "../components/SpanTree.js";
import { SpanDetail } from "../components/SpanDetail.js";
import { Loading, ErrorState } from "../components/states.js";
import type { TraceTreeNode } from "../api/types.js";

/** Depth-first lookup of a span in the tree by spanId. */
function findSpan(node: TraceTreeNode, id: string): TraceTreeNode | undefined {
  if (node.spanId === id) return node;
  for (const child of node.children) {
    const found = findSpan(child, id);
    if (found) return found;
  }
  return undefined;
}

/** Trace view: span tree + detail of the selected span (default: root). */
export function TracePage() {
  const { traceId = "" } = useParams();
  const { data, isLoading, isError } = useTraceTree(traceId);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  if (isLoading) return <Loading label="Loading trace…" />;
  if (isError || !data) return <ErrorState message="Trace not found" />;

  const selected =
    (selectedId != null ? findSpan(data, selectedId) : undefined) ?? data;

  return (
    <main className="trace-page">
      <Link to="/">← Executions</Link>
      <div className="trace-layout">
        <SpanTree
          root={data}
          selectedId={selected.spanId}
          onSelect={(span) => setSelectedId(span.spanId)}
        />
        <SpanDetail span={selected} />
      </div>
    </main>
  );
}
