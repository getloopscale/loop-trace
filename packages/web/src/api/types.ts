/**
 * UI-local copies of the M1 HTTP contract. Declared here (NOT imported from
 * `@usetheo/lens-core`) so the UI depends only on the stable HTTP shape, never on
 * the server's domain/persistence types (ROADMAP M3 risk #2 / ADR D2).
 */
export interface SpanNodeData {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  kind?: string;
  statusCode?: string;
  statusMessage?: string;
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  sessionId?: string;
  attributes?: Record<string, unknown>;
}

export interface TraceTreeNode extends SpanNodeData {
  children: TraceTreeNode[];
}

export interface TraceListItem {
  traceId: string;
  sessionId?: string;
  name?: string;
  startTimeUnixNano?: string;
  durationMs?: number;
  statusCode?: string;
  totalTokens?: number;
}

export interface TraceListResponse {
  traces: TraceListItem[];
}
