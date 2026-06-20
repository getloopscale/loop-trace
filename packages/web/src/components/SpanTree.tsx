import type { TraceTreeNode } from "../api/types.js";
import { durationMs, formatDuration } from "../lib/duration.js";

/** ERROR status — OTLP numeric "2" or the textual "ERROR" the SDK may set. */
function isErrorStatus(code?: string): boolean {
  return code === "2" || code === "ERROR";
}

interface SpanNodeProps {
  node: TraceTreeNode;
  depth: number;
  selectedId: string | undefined;
  onSelect: (span: TraceTreeNode) => void;
}

/**
 * One tree row + its recursive children (M3 ADR D1 — render by recursion over the
 * pre-nested `TraceTreeNode`; virtualization is deferred behind this component).
 *
 * Presented as a plain nested list of <button> rows (every row is keyboard-focusable
 * and Enter/Space-activatable) rather than a WAI-ARIA `tree` widget — a full tree
 * widget needs roving-tabindex + arrow-key navigation we are not implementing in M3
 * (review F-fe-2). Selection is exposed via `aria-current`.
 */
function SpanNode({ node, depth, selectedId, onSelect }: SpanNodeProps) {
  const dur = durationMs(node.startTimeUnixNano, node.endTimeUnixNano);
  const errored = isErrorStatus(node.statusCode);
  return (
    <li>
      <button
        type="button"
        data-depth={depth}
        aria-current={selectedId === node.spanId ? "true" : undefined}
        className={errored ? "span-row span-status-error" : "span-row span-status-ok"}
        style={{ paddingLeft: `${depth * 16}px` }}
        onClick={() => onSelect(node)}
      >
        <span className="span-name">{node.name}</span>
        {/* Status is conveyed by text, not color alone (review F-fe-3). */}
        {errored && <span className="span-status-badge">⚠ error</span>}
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
  return (
    <ul className="span-tree" aria-label="span tree">
      <SpanNode node={root} depth={0} selectedId={selectedId} onSelect={onSelect} />
    </ul>
  );
}
