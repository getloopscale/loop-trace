import type { SpanNodeData, TraceTreeNode } from "../api/types.js";

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

/**
 * Derive a span's kind from signals already on the node (EC-4: tolerates missing
 * attributes). tool > retriever/embedding > llm > chain (has children) > unknown.
 * No schema change — purely client-side classification (D2).
 */
export function deriveSpanKind(span: TraceTreeNode): SpanKind {
  const op = attr(span, "gen_ai.operation.name");
  if (attr(span, "gen_ai.tool.name") != null || op === "execute_tool") return "tool";
  if (op === "retrieve" || op === "search") return "retriever";
  if (op === "embeddings" || op === "embedding") return "embedding";
  if (op === "chat" || op === "text_completion" || span.model != null) return "llm";
  if (span.children.length > 0) return "chain";
  return "unknown";
}

/** True if the node OR any descendant has an error status (child→root propagation, D3). */
export function hasErrorDescendant(node: TraceTreeNode): boolean {
  if (isErrorStatus(node.statusCode)) return true;
  return node.children.some(hasErrorDescendant);
}
