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
  extractSpanEvents,
  capText,
  type SpanEvent,
  INPUT_OUTPUT_CAP,
  MAX_EVENTS,
} from "./domain/span-events.js";
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
export { spans, traces, sessions, replaySessions } from "./infrastructure/db/schema.js";
export {
  DrizzleSpanRepository,
  createPool,
  createSpanRepository,
  migrateLatest,
} from "./infrastructure/db/drizzle-span-repository.js";
