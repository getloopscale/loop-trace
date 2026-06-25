/**
 * UI-local copies of the M1 HTTP contract. Declared here (NOT imported from
 * `@usetheo/lens-core`) so the UI depends only on the stable HTTP shape, never on
 * the server's domain/persistence types (ROADMAP M3 risk #2 / ADR D2).
 */
/** A normalized OTLP span event (M12). */
export interface SpanEvent {
  name: string;
  timeUnixNano?: string;
  attributes?: Record<string, unknown>;
}

/** One online-eval result attached to a span (`eval.<name>.*`, M26). */
export interface SpanEvaluation {
  name: string;
  score?: number;
  label?: string;
  explanation?: string;
}

/** A human-feedback annotation on a trace (spanId omitted) or span (M26b). */
export interface Annotation {
  spanId?: string;
  name: string;
  label?: string;
  note?: string;
  annotatorKind: string;
  updatedAt: string;
}

export interface AnnotationsResponse {
  annotations: Annotation[];
}

/** A curated dataset in the list (with its item count) (M26d). */
export interface Dataset {
  id: string;
  name: string;
  createdAt: string;
  itemCount: number;
}

export interface DatasetsResponse {
  datasets: Dataset[];
}

/** One curated example: the source trace + its input/output snapshot at add-time (M26d). */
export interface DatasetItem {
  traceId: string;
  inputSnapshot?: string;
  outputSnapshot?: string;
  createdAt: string;
}

export interface DatasetDetail {
  id: string;
  name: string;
  createdAt: string;
  items: DatasetItem[];
}

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
  /** Span input text (`input.value`), capped at ingest (M12). */
  inputValue?: string;
  /** Span output text (`output.value`), capped at ingest (M12). */
  outputValue?: string;
  /** OTLP span events, capped at ingest (M12). */
  events?: SpanEvent[];
  /** Online-eval results extracted at ingest (`eval.<name>.*`, M26). */
  evaluations?: SpanEvaluation[];
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
  // M18 — enriched columns for the dense table (mirrors the core DTO). The
  // semantic span-kind is derived client-side from {model, rootOperationName,
  // rootToolName} via the shared span-kind taxonomy.
  model?: string;
  costUsd?: number;
  rootOperationName?: string;
  rootToolName?: string;
  endTimeUnixNano?: string;
  inputPreview?: string;
  outputPreview?: string;
  /** M26b: per-trace online-eval row count (the "Evals" list column); omitted when 0. */
  evaluationsCount?: number;
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
  /** M14: filter to executions carrying this free-form tag. */
  tag?: string;
  /** M24: full-text search over span input/output content. */
  q?: string;
  /** M30: span-query DSL (`kind:llm status:error model:gpt-4o`), parsed server-side. */
  spanQuery?: string;
}

/** A trace's tags (M14). */
export interface TraceTagsResponse {
  tags: string[];
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

/** A session in the sessions list (M13; M20 adds firstMessagePreview). */
export interface SessionListItem {
  sessionId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  traceCount: number;
  costUsd: number;
  totalTokens: number;
  errorRate: number;
  /** M20: first user message (root input of the earliest trace, ≤120 chars); omitted when absent. */
  firstMessagePreview?: string;
  /** M26d: per-session online-eval count (the sessions-list "Evals" column); omitted when 0. */
  evaluationsCount?: number;
}

export interface SessionListResponse {
  sessions: SessionListItem[];
}

/** Session detail: scoped aggregates + member traces (M13). */
export interface SessionDetail {
  sessionId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  traceCount: number;
  costUsd: number;
  totalTokens: number;
  errorRate: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  traces: TraceListItem[];
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

/** Per-evaluator aggregate over the range: avg score + label distribution (M26). */
export interface EvaluatorSummary {
  name: string;
  count: number;
  avgScore?: number;
  labels: Record<string, number>;
}

export interface EvaluatorsResponse {
  evaluators: EvaluatorSummary[];
}
