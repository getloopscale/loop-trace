import { useEffect, useMemo, useRef } from "react";
import type { TraceTreeNode } from "../../api/types.js";
import { durationMs, formatDuration } from "../../lib/duration.js";
import { buildTimeline, type TimelineEntry } from "../../lib/timeline.js";
import {
  deriveSpanKind,
  hasErrorDescendant,
  isErrorStatus,
  type SpanKind,
} from "../../lib/span-kind.js";
import { kindColor } from "../../lib/kind-color.js";

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
        data-status={errored ? "error" : "ok"}
        aria-current={selectedId === node.spanId ? "true" : undefined}
        className="flex w-full items-center gap-3 rounded px-2 py-1.5 text-left transition-colors hover:bg-muted aria-[current=true]:bg-muted"
        style={{ paddingLeft: `${depth * 16}px` }}
        onClick={() => onSelect(node)}
      >
        {/* role=img + aria-label so the kind is announced reliably (the emoji's
            own Unicode name is overridden by the label) — review F-fe-1/F-fe-2. */}
        <span
          className={`w-5 text-center ${kindColor(kind).textClass}`}
          role="img"
          aria-label={`kind: ${kind}`}
          title={kind}
        >
          {KIND_GLYPH[kind]}
        </span>
        <span
          className={`min-w-0 flex-1 truncate ${errored ? "text-destructive" : ""}`}
        >
          {node.name}
        </span>
        {/* Status is conveyed by text, not color alone (review F-fe-3). */}
        {errored && (
          <span className="text-[0.7rem] font-semibold uppercase tracking-wide text-destructive">
            ⚠ error
          </span>
        )}
        {/* Proportional waterfall bar (M10) — decorative; the duration text is the a11y value. */}
        {bar && (
          <span className="relative h-[0.8em] min-w-20 flex-[2] self-center overflow-hidden rounded bg-muted" aria-hidden="true">
            <span
              data-waterfall-bar
              className={`absolute inset-y-0 rounded ${errored ? "bg-destructive" : "bg-muted-foreground"}`}
              style={{ left: `${bar.leftPct}%`, width: `${bar.widthPct}%` }}
            />
          </span>
        )}
        <span className="tabular-nums text-muted-foreground">{formatDuration(dur)}</span>
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
    <div className="flex flex-col gap-2">
      {/* Error propagated from any descendant to the trace root (M10, D3). */}
      {traceErrored && (
        <p
          className="m-0 flex items-center gap-1 rounded-md bg-destructive/10 px-2 py-1.5 text-sm font-semibold text-destructive"
          role="status"
        >
          <span aria-hidden="true">⚠ </span>This trace contains an error
        </p>
      )}
      <ul ref={ref} className="m-0 list-none p-0 [&_ul]:list-none [&_ul]:p-0" aria-label="span tree">
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
