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
 */
function SpanNode({ node, depth, selectedId, onSelect }: SpanNodeProps) {
  const dur = durationMs(node.startTimeUnixNano, node.endTimeUnixNano);
  return (
    <li role="treeitem" aria-selected={selectedId === node.spanId}>
      <button
        type="button"
        data-depth={depth}
        className={isErrorStatus(node.statusCode) ? "span-row span-status-error" : "span-row span-status-ok"}
        style={{ paddingLeft: `${depth * 16}px` }}
        onClick={() => onSelect(node)}
      >
        <span className="span-name">{node.name}</span>
        <span className="span-duration">{formatDuration(dur)}</span>
      </button>
      {node.children.length > 0 && (
        <ul role="group">
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
  selectedId?: string;
  onSelect: (span: TraceTreeNode) => void;
}

export function SpanTree({ root, selectedId, onSelect }: SpanTreeProps) {
  return (
    <ul className="span-tree" role="tree" aria-label="span tree">
      <SpanNode node={root} depth={0} selectedId={selectedId} onSelect={onSelect} />
    </ul>
  );
}
