import type { SpanNodeData, TraceTreeNode, TraceListItem } from "../api/types.js";

/** Canonical span kinds (mirrors the Phoenix taxonomy we can derive from our signals). */
export type SpanKind =
  | "llm"
  | "tool"
  | "retriever"
  | "embedding"
  | "chain"
  | "unknown";

/** Error status tokens — aligned with core `ERROR_STATUS_CODES` (EC-5). */
const ERROR_STATUS = new Set(["2", "ERROR", "STATUS_CODE_ERROR"]);

export function isErrorStatus(code: string | undefined): boolean {
  return code != null && ERROR_STATUS.has(code);
}

function attr(span: SpanNodeData, key: string): string | undefined {
  const a = span.attributes;
  if (a == null || typeof a !== "object") return undefined;
  const v = (a as Record<string, unknown>)[key];
  return typeof v === "string" ? v : undefined;
}

/** The signals span-kind classification reads — shared by span + trace-list callers. */
export interface KindSignals {
  operationName?: string | undefined;
  toolName?: string | undefined;
  model?: string | undefined;
  hasChildren: boolean;
}

/**
 * Single source of truth for span-kind classification (M18 — extracted for DRY).
 * tool > retriever > embedding > llm > chain (has children) > unknown.
 */
export function deriveKindFromSignals(s: KindSignals): SpanKind {
  if (s.toolName != null || s.operationName === "execute_tool") return "tool";
  if (s.operationName === "retrieve" || s.operationName === "search") {
    return "retriever";
  }
  if (s.operationName === "embeddings" || s.operationName === "embedding") {
    return "embedding";
  }
  if (
    s.operationName === "chat" ||
    s.operationName === "text_completion" ||
    s.model != null
  ) {
    return "llm";
  }
  if (s.hasChildren) return "chain";
  return "unknown";
}

/**
 * Derive a span's kind from signals already on the node (EC-4: tolerates missing
 * attributes). Purely client-side classification (D2).
 */
export function deriveSpanKind(span: TraceTreeNode): SpanKind {
  return deriveKindFromSignals({
    operationName: attr(span, "gen_ai.operation.name"),
    // M34: the typed `toolName` column (set from `tool_name` for Claude Code, or
    // `gen_ai.tool.name` for others) wins; fall back to the attr for legacy spans.
    toolName: span.toolName ?? attr(span, "gen_ai.tool.name"),
    model: span.model ?? undefined,
    hasChildren: span.children.length > 0,
  });
}

/**
 * List-level kind from the M18-enriched `TraceListItem` root-span signals. The list
 * carries no child info, so a would-be "chain" falls through to "unknown" (matching
 * Arize, which shows UNKNOWN for the root graph span).
 */
export function deriveTraceListItemKind(item: TraceListItem): SpanKind {
  return deriveKindFromSignals({
    operationName: item.rootOperationName,
    toolName: item.rootToolName,
    model: item.model,
    hasChildren: false,
  });
}

/** True if the node OR any descendant has an error status (child→root propagation, D3). */
export function hasErrorDescendant(node: TraceTreeNode): boolean {
  if (isErrorStatus(node.statusCode)) return true;
  return node.children.some(hasErrorDescendant);
}
