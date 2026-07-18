/**
 * @usetheo/lens-core barrel — domain types, repository port, and Drizzle adapter.
 */
export { type Span, spanSchema } from "./domain/span.js";
export {
  type SpanRepository,
  type TraceTreeNode,
  type TraceReadRepository,
  type AggregateRepository,
  type SessionRepository,
  type AnnotationRepository,
  type DatasetRepository,
  type CopilotFeedbackRepository,
  type LabelingQueueRepository,
  type ExperimentRepository,
  type RetentionRepository,
} from "./domain/span-repository.js";
export { NameConflictError, isUniqueViolation, isForeignKeyViolation } from "./domain/errors.js";
export { type ApiErrorBody, type FieldIssue, apiError, zodFieldErrors } from "./domain/api-error.js";
// M118 (D3) — the single typed error envelope: a stable code union + `errorBody` (shape == apiError).
export { ERROR_CODES, type ErrorCode, isErrorCode, errorBody } from "./domain/error-envelope.js";
export { type SqlResult, rowsAs } from "./domain/sql-rows.js";
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
  scoreBucketSchema,
  scoresResponseSchema,
  type SpanEvaluation,
  type EvaluatorSummary,
  type EvaluatorsResponse,
  type ScoreBucket,
  type ScoresResponse,
} from "./domain/evaluation.js";
export {
  spanFacetsResponseSchema,
  type SpanFacetsResponse,
  type SpanAttributeKey,
  type SpanAttributeValue,
} from "./domain/span-facets.js";
export { isValidAttrKey, parseSpanQuery, type SpanClause, type SpanQuery } from "./domain/span-query.js";
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
  openaiChatCompletionWithUsage,
  OpenAICompatibleChat,
  OpenAICompatibleReplay,
  type ChatClient,
  type ChatCompletionWithUsage,
  type ChatConfig,
  type ChatMessage,
  type ReplayClient,
  type ReplayResult,
} from "./domain/chat.js";
export {
  buildCopilotPrompt,
  validateQuestion,
  capAnswer,
  CopilotError,
  MAX_ANSWER_BYTES,
} from "./domain/copilot.js";
export { RateLimiter } from "./domain/rate-limiter.js";
// M118 (D2) — provider circuit breaker (hand-rolled closed/open/half-open, fast-fail 503 when OPEN).
export {
  ProviderBreaker,
  ProviderBreakerOpenError,
  type ProviderBreakerConfig,
  DEFAULT_PROVIDER_BREAKER,
} from "./domain/provider-breaker.js";
// M118 (D4) — zod-at-the-boundary response schemas for the advanced write routes (server-side single
// source of truth; lifted from the M117 SDK hand-types, wire shape unchanged).
export {
  evaluatorRecordSchema,
  evaluatorsListResponseSchema,
  guardRecordSchema,
  guardsListResponseSchema,
  runResultResponseSchema,
  experimentRunsListResponseSchema,
  runCompareDeltasSchema,
  experimentCompareResponseSchema,
  askCopilotResponseSchema,
  copilotFeedbackRecordSchema,
  replayResponseSchema,
} from "./domain/advanced-responses.js";
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
  parseEvaluatorRpm,
  parseIngestRpm,
  parseMaxIngestBytes,
  parseMaxDecompressedBytes,
  parsePoolConfig,
  parseHttpRequestTimeoutMs,
  parseShutdownDrainMs,
  parseProviderRetry,
  parseProviderBreaker,
  type PoolConfig,
  type ProviderRetryConfig,
  DEFAULT_EVAL_BACKFILL_MAX,
  DEFAULT_COPILOT_RPM,
  DEFAULT_EVALUATOR_RPM,
  DEFAULT_INGEST_RPM,
  DEFAULT_MAX_INGEST_BYTES,
  DEFAULT_MAX_DECOMPRESSED_BYTES,
  DEFAULT_POOL_CONFIG,
  DEFAULT_HTTP_REQUEST_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_DRAIN_MS,
  DEFAULT_PROVIDER_RETRY,
} from "./domain/evaluator-config.js";
export { positiveIntEnv } from "./domain/env.js";
export {
  createProviderClients,
  type ProviderClients,
} from "./domain/provider-clients.js";
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
// M83: copilot answer feedback.
export {
  normalizeAskFeedback,
  InvalidFeedbackError,
  type FeedbackLabel,
  type AskFeedbackInput,
  type CopilotFeedbackRecord,
} from "./domain/copilot-feedback.js";
// M63: labeling queues (human-in-the-loop review).
export {
  normalizeLabelResolution,
  labelingQueueItemSchema,
  labelingQueuePageSchema,
  LABELING_QUEUE_STATUSES,
  RESOLUTION_SCHEMA_VERSION,
  type LabelingQueueItem,
  type LabelingQueuePage,
  type LabelingQueueStatus,
  type NormalizedResolution,
} from "./domain/labeling-queue.js";
// M64: experiments (regression-dataset-run + compare).
export {
  aggregateRun,
  compareRuns,
  experimentRunSchema,
  experimentRunItemSchema,
  runVariantSchema,
  RUN_STATUSES,
  type ExperimentRun,
  type ExperimentRunItem,
  type RunVariant,
  type RunStatus,
  type RunScore,
  type RunAggregate,
} from "./domain/experiment.js";
export {
  runExperiment,
  MAX_RUN_ITEMS,
  type RunInput,
  type RunDeps,
  type RunOutput,
  type RunDatasetItem,
} from "./domain/experiment-engine.js";
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

// M116 — the core copy of the SDKMessage→OTLP mapper powering the native POST /v1/runs endpoint.
export { sdkMessagesToOtlp, THEOKIT_SERVICE_NAME } from "./domain/theokit/sdk-messages-to-otlp.js";
export type { OtlpTraces } from "./domain/theokit/sdk-messages-to-otlp.js";
export type { SDKMessage, RunResult as TheokitRunResult } from "./domain/theokit/sdk-message.js";
// M119 (D1) — the shared SDKMessage→OTLP mapper drift-guard fixture (TEST support): the 18 documented
// behaviors imported by BOTH mapper test files (the SDK test resolves this via @usetheo/lens-core).
export { MAPPER_VECTORS, flattenOtlp, T0 as MAPPER_VECTOR_T0 } from "./domain/theokit/theokit-vectors.js";
export type { MapperVector, SdkMapper, OtlpTracesLike } from "./domain/theokit/theokit-vectors.js";
