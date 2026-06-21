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

export interface TraceCost {
  traceId: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CostBucket {
  periodStart: string;
  costUsd: number;
  totalTokens: number;
  traceCount: number;
}

export interface CostByPeriodResponse {
  period: "day" | "week";
  buckets: CostBucket[];
}

export interface ToolStat {
  toolName: string;
  callCount: number;
  errorCount: number;
  errorRate: number;
  p50Ms: number;
  p95Ms: number;
}

export interface ToolStatsResponse {
  tools: ToolStat[];
}
