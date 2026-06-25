/**
 * @usetheo/lens-core barrel — domain types, repository port, and Drizzle adapter.
 */
export { type Span, spanSchema } from "./domain/span.js";
export { type SpanRepository, type TraceTreeNode } from "./domain/span-repository.js";
export {
  traceListItemSchema,
  traceListResponseSchema,
  listTracesOptionsSchema,
  LIST_TRACES_LIMIT_CAP,
  type TraceListItem,
  type TraceListResponse,
  type ListTracesOptions,
} from "./domain/trace-list.js";
export { extractGenAi, type GenAiFields } from "./domain/genai-attributes.js";
export {
  type AgentAdapter,
  serviceNameOf,
  stripContextWindowSuffix,
} from "./domain/adapters/agent-adapter.js";
export { defaultAdapter } from "./domain/adapters/default-adapter.js";
export { claudeCodeAdapter } from "./domain/adapters/claude-code-adapter.js";
export { selectAdapter } from "./domain/adapters/registry.js";
// Only extractSpanEvents has a cross-package consumer (the OTLP ingest parser);
// the caps + capText + SpanEvent type stay module-internal (YAGNI — no orphan
// public exports). Tests import them via relative path.
export { extractSpanEvents } from "./domain/span-events.js";
// M26: online-eval extraction (ingest) + types (consumed by the OTLP parser + API).
export {
  extractEvaluations,
  type SpanEvaluation,
  type EvaluatorSummary,
} from "./domain/evaluation.js";
export {
  percentile,
  computeToolStats,
  toolStatSchema,
  toolStatsResponseSchema,
  type ToolSample,
  type ToolStat,
  type ToolStatsResponse,
} from "./domain/tool-stats.js";
export {
  computeTraceCost,
  resolveModelPrice,
  type ModelPrice,
  type PriceTable,
  type ModelUsage,
} from "./domain/pricing.js";
export { DEFAULT_PRICES } from "./domain/default-prices.js";
export {
  traceCostSchema,
  costBucketSchema,
  costByPeriodResponseSchema,
  type TraceCost,
  type CostBucket,
  type CostByPeriodResponse,
  type CostPeriod,
} from "./domain/cost.js";
export {
  northStarBucketSchema,
  northStarResponseSchema,
  shapeNorthStarBuckets,
  type NorthStarBucket,
  type NorthStarResponse,
} from "./domain/north-star.js";
export {
  observabilityRangeSchema,
  observabilityResponseSchema,
  shapeObservability,
  RANGE_BUCKETS,
  type ObservabilityRange,
  type ObservabilityResponse,
  type RawObservability,
} from "./domain/observability.js";
export {
  sessionListItemSchema,
  sessionListResponseSchema,
  sessionDetailResponseSchema,
  shapeSessionDetail,
  isoTimestamp,
  type SessionListItem,
  type SessionListResponse,
  type SessionDetailResponse,
  type RawSessionDetail,
} from "./domain/session.js";
export {
  traceTagsResponseSchema,
  normalizeTag,
  TAG_MAX_LENGTH,
  type TraceTagsResponse,
} from "./domain/tags.js";
export {
  type PruneStats,
  type RetentionConfig,
  parseRetentionConfig,
} from "./domain/retention.js";
export { spans, traces, sessions, replaySessions } from "./infrastructure/db/schema.js";
export {
  DrizzleSpanRepository,
  createPool,
  createSpanRepository,
  migrateLatest,
} from "./infrastructure/db/drizzle-span-repository.js";
