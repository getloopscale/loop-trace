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

/** Whitelisted executions-list query (M9 — mirrors the API param whitelist). */
export interface ListTracesQuery {
  status?: "ok" | "error";
  model?: string;
  /** ISO datetime (with offset) lower/upper bound on updated_at. */
  from?: string;
  to?: string;
  orderBy?: "recent" | "latency" | "tokens" | "cost";
  dir?: "asc" | "desc";
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

export interface NorthStarBucket {
  period: string;
  count: number;
}

export interface NorthStarResponse {
  tracesPerDay: NorthStarBucket[];
  replaySessionsPerWeek: NorthStarBucket[];
}

/** Time-range presets for the observability dashboard (M11 — mirrors the API whitelist). */
export type ObservabilityRange = "1h" | "24h" | "7d" | "30d";

export interface TrafficBucket {
  periodStart: string;
  traceCount: number;
  errorCount: number;
  errorRate: number;
}

export interface LatencyBucket {
  periodStart: string;
  p50Ms: number;
  p75Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface ModelTokenBucket {
  periodStart: string;
  model: string;
  totalTokens: number;
  costUsd: number;
}

export interface ObservabilityResponse {
  range: ObservabilityRange;
  traffic: TrafficBucket[];
  latency: LatencyBucket[];
  tokensByModel: ModelTokenBucket[];
}
