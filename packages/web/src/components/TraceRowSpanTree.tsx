import { useTraceTree } from "../hooks/useTraces.js";
import type { TraceTreeNode } from "../api/types.js";
import { deriveSpanKind } from "../lib/span-kind.js";
import { durationMs, formatDuration } from "../lib/duration.js";
import { KindBadge } from "./kind-badge.js";

/**
 * Inline span tree for an expanded executions row (M29d — Arize live-parity). The
 * executions list row IS the root span, so this renders the root's DESCENDANTS as a
 * compact, read-only, depth-indented list: canonical kind badge (M29 `kindColor`) +
 * span name + latency + tokens. Lazily backed by `useTraceTree` (it only fetches when
 * this component mounts — i.e. when the row is expanded; ADR D1, no list-endpoint N+1).
 * Read-only by design — the full interactive 3-pane stays the row's `name` link.
 */
interface FlatSpan {
  node: TraceTreeNode;
  depth: number;
}

/** Depth-first flatten of a node's descendants (the root is the row, excluded here). */
function flattenChildren(root: TraceTreeNode): FlatSpan[] {
  const out: FlatSpan[] = [];
  const walk = (node: TraceTreeNode, depth: number) => {
    for (const child of node.children) {
      out.push({ node: child, depth });
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

const muted = "text-muted-foreground text-body-sm";

export function TraceRowSpanTree({ traceId }: { traceId: string }) {
  const { data, isError } = useTraceTree(traceId);

  if (isError) return <span className={muted}>Failed to load spans</span>;
  if (!data) return <span className={muted}>Loading spans…</span>;

  const rows = flattenChildren(data);
  if (rows.length === 0) return <span className={muted}>No child spans</span>;

  return (
    <ul aria-label="span tree" className="flex flex-col gap-0.5">
      {rows.map(({ node, depth }) => {
        const kind = deriveSpanKind(node);
        const dur = durationMs(node.startTimeUnixNano, node.endTimeUnixNano);
        const tokens = (node.inputTokens ?? 0) + (node.outputTokens ?? 0);
        return (
          <li
            key={node.spanId}
            className="flex items-center gap-2 text-body-sm"
            style={{ paddingLeft: `${depth * 16}px` }}
          >
            <KindBadge kind={kind} />
            <span className="font-mono text-foreground">{node.name}</span>
            <span className={muted}>{formatDuration(dur)}</span>
            {tokens > 0 ? <span className={muted}>{tokens} tk</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
