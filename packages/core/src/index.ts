/**
 * @usetheo/lens-core barrel — domain types, repository port, and Drizzle adapter.
 */
export { type Span, spanSchema } from "./domain/span.js";
export { type SpanRepository, type TraceTreeNode } from "./domain/span-repository.js";
export {
  traceListItemSchema,
  traceListResponseSchema,
  type TraceListItem,
  type TraceListResponse,
} from "./domain/trace-list.js";
export { extractGenAi, type GenAiFields } from "./domain/genai-attributes.js";
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
export { spans, traces, sessions } from "./infrastructure/db/schema.js";
export {
  DrizzleSpanRepository,
  createPool,
  createSpanRepository,
  migrateLatest,
} from "./infrastructure/db/drizzle-span-repository.js";
