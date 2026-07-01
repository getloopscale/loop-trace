/**
 * @usetheo/lens-core barrel — domain types, repository port, and Drizzle adapter.
 */
export { type Span, spanSchema } from "./domain/span.js";
export { type SpanRepository, type TraceTreeNode } from "./domain/span-repository.js";
// M22: multi-tenant workspace-isolation domain types (ported from theo-memory).
export {
  type Workspace,
  type WorkspaceRole,
  type Principal,
  type AuthVerifier,
  roleSatisfies,
  makeVerifyShim,
  DEFAULT_WORKSPACE_ID,
  DEFAULT_OWNER_USER_ID,
} from "./domain/principal.js";
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
  evaluatorSummarySchema,
  evaluatorsResponseSchema,
  type SpanEvaluation,
  type EvaluatorSummary,
  type EvaluatorsResponse,
} from "./domain/evaluation.js";
// M36: online evaluators (compute/write path) — types + pure rule/guard engines.
export {
  EVALUATOR_KINDS,
  GUARD_OPERATORS,
  evaluatorSchema,
  guardSchema,
  ruleConfigSchema,
  judgeConfigSchema,
  evaluateRule,
  spanMatchesPredicate,
  validatePredicate,
  deriveKind,
  type EvaluatorKind,
  type GuardOperator,
  type Evaluator,
  type Guard,
  type Verdict,
  type RunResult,
} from "./domain/evaluator.js";
export {
  ChatError,
  openaiChatCompletion,
  OpenAICompatibleChat,
  type ChatClient,
  type ChatConfig,
  type ChatMessage,
} from "./domain/chat.js";
export {
  buildCopilotPrompt,
  validateQuestion,
  capAnswer,
  CopilotError,
  MAX_ANSWER_BYTES,
} from "./domain/copilot.js";
export { RateLimiter } from "./domain/rate-limiter.js";
export {
  JudgeError,
  OpenAICompatibleJudge,
  parseJudgeVerdict,
  type JudgeClient,
  type JudgeConfig,
} from "./domain/llm-judge.js";
export {
  parseJudgeConfig,
  parseEvalSweepHours,
  parseBackfillMax,
  parseCopilotRpm,
  DEFAULT_EVAL_BACKFILL_MAX,
  DEFAULT_COPILOT_RPM,
} from "./domain/evaluator-config.js";
export {
  runEvaluator,
  runSweep,
  type EngineDeps,
  type RunOptions,
} from "./domain/evaluator-engine.js";
export type {
  EvaluatorRepository,
  EvaluatorRecord,
  GuardRecord,
} from "./domain/evaluator-repository.js";
export {
  DrizzleEvaluatorRepository,
  createEvaluatorRepository,
  evaluatorRepoFromPool,
} from "./infrastructure/db/drizzle-evaluator-repository.js";
// M26b: human-feedback annotations (write-path).
export {
  normalizeAnnotation,
  annotationSchema,
  annotationsResponseSchema,
  DEFAULT_ANNOTATION_NAME,
  DEFAULT_ANNOTATOR_KIND,
  type Annotation,
  type AnnotationsResponse,
  type NormalizedAnnotation,
} from "./domain/annotation.js";
// M26d: curated datasets.
export {
  normalizeDatasetName,
  datasetSchema,
  datasetItemSchema,
  datasetsResponseSchema,
  datasetDetailSchema,
  DATASET_NAME_MAX,
  type Dataset,
  type DatasetItem,
  type DatasetsResponse,
  type DatasetDetail,
} from "./domain/dataset.js";
// M32: agents catalog (derived).
export {
  classifyAgentHealth,
  shapeAgent,
  agentSchema,
  agentCatalogResponseSchema,
  AGENT_STALE_DAYS,
  AGENT_CHURN_THRESHOLD,
  type Agent,
  type AgentCatalogResponse,
  type RawAgent,
} from "./domain/agent-catalog.js";
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
export { spans, traces, sessions, replaySessions, evaluators, guards } from "./infrastructure/db/schema.js";
export {
  DrizzleSpanRepository,
  createPool,
  createSpanRepository,
  migrateLatest,
} from "./infrastructure/db/drizzle-span-repository.js";
