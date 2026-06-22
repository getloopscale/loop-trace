import { useEffect, useMemo, useRef } from "react";
import type { TraceTreeNode } from "../api/types.js";
import { durationMs, formatDuration } from "../lib/duration.js";
import { buildTimeline, type TimelineEntry } from "../lib/timeline.js";
import {
  deriveSpanKind,
  hasErrorDescendant,
  isErrorStatus,
  type SpanKind,
} from "../lib/span-kind.js";

/** Short glyph per span kind (meaning conveyed by the aria-label, not color alone). */
const KIND_GLYPH: Record<SpanKind, string> = {
  llm: "✦",
  tool: "⚙",
  retriever: "🔎",
  embedding: "⋮",
  chain: "⛓",
  unknown: "•",
};

interface SpanNodeProps {
  node: TraceTreeNode;
  depth: number;
  selectedId: string | undefined;
  onSelect: (span: TraceTreeNode) => void;
  timeline: Map<string, TimelineEntry>;
}

/**
 * One tree row + its recursive children (M3). M10 enriches each row with a
 * span-kind glyph + a proportional waterfall bar (positioned by `buildTimeline`).
 * Selection (`aria-current`) still drives detail + replay; the replay step order
 * (`buildReplaySteps`) is unchanged.
 */
function SpanNode({ node, depth, selectedId, onSelect, timeline }: SpanNodeProps) {
  const dur = durationMs(node.startTimeUnixNano, node.endTimeUnixNano);
  const errored = isErrorStatus(node.statusCode);
  const kind = deriveSpanKind(node);
  const bar = timeline.get(node.spanId);
  return (
    <li>
      <button
        type="button"
        data-depth={depth}
        data-kind={kind}
        aria-current={selectedId === node.spanId ? "true" : undefined}
        className={errored ? "span-row span-status-error" : "span-row span-status-ok"}
        style={{ paddingLeft: `${depth * 16}px` }}
        onClick={() => onSelect(node)}
      >
        {/* role=img + aria-label so the kind is announced reliably (the emoji's
            own Unicode name is overridden by the label) — review F-fe-1/F-fe-2. */}
        <span className="span-kind" role="img" aria-label={`kind: ${kind}`} title={kind}>
          {KIND_GLYPH[kind]}
        </span>
        <span className="span-name">{node.name}</span>
        {/* Status is conveyed by text, not color alone (review F-fe-3). */}
        {errored && <span className="span-status-badge">⚠ error</span>}
        {/* Proportional waterfall bar (M10) — decorative; the duration text is the a11y value. */}
        {bar && (
          <span className="span-waterfall" aria-hidden="true">
            <span
              className="span-waterfall-bar"
              style={{ left: `${bar.leftPct}%`, width: `${bar.widthPct}%` }}
            />
          </span>
        )}
        <span className="span-duration">{formatDuration(dur)}</span>
      </button>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <SpanNode
              key={child.spanId}
              node={child}
              depth={depth + 1}
              selectedId={selectedId}
              onSelect={onSelect}
              timeline={timeline}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export interface SpanTreeProps {
  root: TraceTreeNode;
  selectedId?: string | undefined;
  onSelect: (span: TraceTreeNode) => void;
}

export function SpanTree({ root, selectedId, onSelect }: SpanTreeProps) {
  const ref = useRef<HTMLUListElement>(null);
  // Waterfall geometry computed once per tree (pure, BigInt — M10).
  const timeline = useMemo(() => buildTimeline(root), [root]);
  const traceErrored = useMemo(() => hasErrorDescendant(root), [root]);
  // Keep the active (replay) span in view as the step advances (review F-fe-4).
  useEffect(() => {
    if (selectedId == null) return;
    const el = ref.current?.querySelector('[aria-current="true"]');
    (el as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" });
  }, [selectedId]);
  return (
    <div className="span-tree-wrap">
      {/* Error propagated from any descendant to the trace root (M10, D3). */}
      {traceErrored && (
        <p className="trace-error-summary" role="status">
          <span aria-hidden="true">⚠ </span>This trace contains an error
        </p>
      )}
      <ul ref={ref} className="span-tree" aria-label="span tree">
        <SpanNode
          node={root}
          depth={0}
          selectedId={selectedId}
          onSelect={onSelect}
          timeline={timeline}
        />
      </ul>
    </div>
  );
}
