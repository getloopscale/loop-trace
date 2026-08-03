/**
 * @usetheo/lens-core barrel — domain types, repository port, and Drizzle adapter.
 */
export { type Span, spanSchema } from "./domain/observability/span.js";
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
} from "./domain/observability/span-repository.js";
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
} from "./domain/observability/trace-list.js";
export { extractGenAi, type GenAiFields } from "./domain/observability/genai-attributes.js";
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
export { extractSpanEvents } from "./domain/observability/span-events.js";
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
} from "./domain/evaluation/evaluation.js";
export {
  spanFacetsResponseSchema,
  type SpanFacetsResponse,
  type SpanAttributeKey,
  type SpanAttributeValue,
} from "./domain/observability/span-facets.js";
export { isValidAttrKey, parseSpanQuery, type SpanClause, type SpanQuery } from "./domain/observability/span-query.js";
// M36: online evaluators (compute/write path) — types + pure rule/guard engines.
export {
  EVALUATOR_KINDS,
  MONITOR_OPERATORS,
  evaluatorSchema,
  monitorSchema,
  ruleConfigSchema,
  judgeConfigSchema,
  evaluateRule,
  spanMatchesPredicate,
  validatePredicate,
  deriveKind,
  type EvaluatorKind,
  type MonitorOperator,
  type Evaluator,
  type Monitor,
  type Verdict,
  type RunResult,
} from "./domain/evaluation/evaluator.js";
// M139 — o harness de eval (dataset + runner). Domínio puro: o CLI `scripts/run-eval.mjs` é a
// única camada com I/O, e consome estes símbolos pelo barrel.
// Só o que o CLI de fato consome. A primeira versão exportava também `evalDatasetSchema`,
// `EVAL_SPLITS` e `EvalRunOptions` — nenhum tinha importador fora do próprio módulo e do teste que
// registra os nomes do barrel, o que é `soft_cap_orphan_export_typescript`. Exportar "por
// completude" engorda a superfície pública logo depois de a M129 tê-la deliberadamente encolhido:
// cada nome aqui é um compromisso de compatibilidade que alguém paga depois.
export {
  parseEvalDataset,
  SHIPPED_DATASET_PATH,
  type EvalDataset,
  type EvalExample,
  type EvalSplit,
} from "./domain/evaluation/eval-dataset.js";
export {
  runEvalDataset,
  RegressionError,
  type EvalRunResult,
  type ExampleResult,
} from "./domain/evaluation/eval-runner.js";
// M129: the `provider` domain (chat, breaker, env, client factory) is NO LONGER on the root barrel.
// It moved behind the `@usetheo/lens-core/provider` subpath (packages/core/src/domain/provider/index.ts)
// to shrink the root god-barrel; composition roots + handlers import provider symbols from there.
// Guarded by barrel-public-surface.test.ts.
export {
  buildCopilotPrompt,
  validateQuestion,
  capAnswer,
  CopilotError,
  MAX_ANSWER_BYTES,
} from "./domain/evaluation/copilot.js";
export { RateLimiter } from "./domain/rate-limiter.js";
// M118 (D2) — provider circuit breaker (ProviderBreaker/ProviderBreakerOpenError/DEFAULT_PROVIDER_BREAKER)
// moved to the `@usetheo/lens-core/provider` subpath in M129 (see the note above).
// M118 (D4) — zod-at-the-boundary response schemas for the advanced write routes (server-side single
// source of truth; lifted from the M117 SDK hand-types, wire shape unchanged).
export {
  evaluatorRecordSchema,
  evaluatorsListResponseSchema,
  monitorRecordSchema,
  monitorsListResponseSchema,
  runResultResponseSchema,
  evaluatorRunJobResponseSchema,
  experimentRunsListResponseSchema,
  runCompareDeltasSchema,
  experimentCompareResponseSchema,
  askCopilotResponseSchema,
  copilotFeedbackRecordSchema,
  replayResponseSchema,
} from "./domain/evaluation/advanced-responses.js";
export {
  JudgeError,
  OpenAICompatibleJudge,
  parseJudgeVerdict,
  type JudgeClient,
  type JudgeConfig,
} from "./domain/evaluation/llm-judge.js";
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
} from "./domain/evaluation/evaluator-config.js";
// M129: positiveIntEnv (env leaf) + createProviderClients/ProviderClients (client factory) moved to the
// `@usetheo/lens-core/provider` subpath (see the note above).
export {
  runEvaluator,
  runSweep,
  mapPool,
  RUN_CONCURRENCY,
  type EngineDeps,
  type RunOptions,
  type RunHooks,
} from "./domain/evaluation/evaluator-engine.js";
// M134 — auto-evaluation of new traces. The daemon lives in `packages/api`, so
// these domain predicates must be reachable from the barrel (core never imports api).
export { shouldSample } from "./domain/evaluation/should-sample.js";
export {
  claimNextJobs,
  completeJob,
  failJob,
  heartbeat,
  reclaimStale,
  MAX_ATTEMPTS,
  type ClaimedJob,
  type Queryable,
} from "./domain/evaluation/eval-job-claim.js";
export {
  matchesFilter,
  validateFilter,
  isKnownFilterColumn,
  KNOWN_FILTER_COLUMNS,
  UnknownFilterColumnError,
  type FilterClause,
  type FilterColumn,
  type FilterOperator,
} from "./domain/evaluation/trace-filter.js";
// M133 — async evaluator-run jobs (registry + background orchestrator + view mapper).
export {
  EvaluatorRunJobRegistry,
  runEvaluatorRunJob,
  toRunJobView,
  type EvaluatorRunJob,
  type EvaluatorRunJobView,
  type RunJobStatus,
} from "./domain/evaluation/evaluator-run-job.js";
export type {
  EvaluatorRepository,
  EvaluatorRecord,
  MonitorRecord,
} from "./domain/evaluation/evaluator-repository.js";
// M131 B2/B3 — session-level Session Coherence evaluator + cached runner (reuses the M36 JudgeClient).
export {
  evaluateSessionCoherence,
  assembleSessionTranscript,
  shapeCoherenceVerdict,
  SESSION_COHERENCE_NAME,
  SESSION_COHERENCE_PROMPT,
  COHERENCE_THRESHOLD,
  type SessionCoherenceVerdict,
} from "./domain/evaluation/session-coherence.js";
export {
  runSessionCoherence,
  sessionVersion,
  type SessionCoherenceDeps,
  type SessionCoherenceResult,
  type CachedSessionVerdict,
  type SessionVerdictWrite,
} from "./domain/evaluation/session-coherence-runner.js";
export {
  upsertSessionVerdict,
  getSessionVerdict,
  sessionVerdictStoreFromPool,
  type SessionVerdictRecord,
  type SessionVerdictStore,
} from "./infrastructure/db/evaluation/session-evaluation-repository.js";
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
} from "./domain/observability/annotation.js";
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
} from "./domain/evaluation/dataset.js";
// M83: copilot answer feedback.
export {
  normalizeAskFeedback,
  InvalidFeedbackError,
  type FeedbackLabel,
  type AskFeedbackInput,
  type CopilotFeedbackRecord,
} from "./domain/evaluation/copilot-feedback.js";
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
} from "./domain/evaluation/labeling-queue.js";
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
} from "./domain/evaluation/experiment.js";
export {
  runExperiment,
  MAX_RUN_ITEMS,
  type RunInput,
  type RunDeps,
  type RunOutput,
  type RunDatasetItem,
} from "./domain/evaluation/experiment-engine.js";
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
} from "./domain/observability/agent-catalog.js";
export {
  percentile,
  computeToolStats,
  toolStatSchema,
  toolStatsResponseSchema,
  type ToolSample,
  type ToolStat,
  type ToolStatsResponse,
} from "./domain/observability/tool-stats.js";
export {
  computeTraceCost,
  resolveModelPrice,
  type ModelPrice,
  type PriceTable,
  type ModelUsage,
} from "./domain/observability/pricing.js";
export { DEFAULT_PRICES } from "./domain/observability/default-prices.js";
export {
  traceCostSchema,
  costBucketSchema,
  costByPeriodResponseSchema,
  type TraceCost,
  type CostBucket,
  type CostByPeriodResponse,
  type CostPeriod,
} from "./domain/observability/cost.js";
export {
  northStarBucketSchema,
  northStarResponseSchema,
  shapeNorthStarBuckets,
  type NorthStarBucket,
  type NorthStarResponse,
} from "./domain/observability/north-star.js";
export {
  observabilityRangeSchema,
  observabilityResponseSchema,
  shapeObservability,
  RANGE_BUCKETS,
  type ObservabilityRange,
  type ObservabilityResponse,
  type RawObservability,
} from "./domain/observability/observability.js";
export {
  sessionListItemSchema,
  sessionListResponseSchema,
  sessionDetailResponseSchema,
  sessionCoherenceResponseSchema,
  shapeSessionDetail,
  isoTimestamp,
  type SessionListItem,
  type SessionListResponse,
  type SessionDetailResponse,
  type SessionCoherenceResponse,
  type RawSessionDetail,
} from "./domain/observability/session.js";
export {
  traceTagsResponseSchema,
  normalizeTag,
  TAG_MAX_LENGTH,
  type TraceTagsResponse,
} from "./domain/observability/tags.js";
export {
  type PruneStats,
  type RetentionConfig,
  parseRetentionConfig,
} from "./domain/observability/retention.js";
// M122: the infra concretes (Drizzle repos + raw table schemas) are NOT part of the
// domain public API — they live behind the @usetheo/lens-core/infra subpath
// (packages/core/src/infrastructure/db/index.ts). Composition roots import them from
// there; the root barrel exposes domain ports/types/DTOs only. Guarded by
// barrel-surface.test.ts (test_root_barrel_exports_no_infra_symbol).

// M116 — the core copy of the SDKMessage→OTLP mapper powering the native POST /v1/runs endpoint.
export { sdkMessagesToOtlp, THEOKIT_SERVICE_NAME } from "./domain/theokit/sdk-messages-to-otlp.js";
export type { OtlpTraces } from "./domain/theokit/sdk-messages-to-otlp.js";
export type { SDKMessage, RunResult as TheokitRunResult } from "./domain/theokit/sdk-message.js";
// M128 — the shared SDKMessage→OTLP mapper drift-guard fixture (MAPPER_VECTORS/flattenOtlp/… — TEST support)
// is NO LONGER on the production root barrel. It now lives behind the dedicated `@usetheo/lens-core/testing`
// subpath (see package.json `exports`), so the prod public API stops carrying test-only exports. The SDK
// mapper-drift test imports it from `@usetheo/lens-core/testing`; core's own tests import it directly from
// `./domain/theokit/theokit-vectors.js`.

// M140 — consumption grouped by end user (report contract + the unattributed bucket).
// M143 — o eixo de tempo: `MAX_BUCKET_POINTS` e o schema do ponto da série. O teto SÓ funciona se
// atravessar o barrel: sem esta linha ele fica `undefined` na rota, `pontos > undefined` é sempre
// falso, e o endpoint aceita em silêncio o pedido que deveria recusar — medido nesta milestone.
export {
  MAX_BUCKET_POINTS,
  MAX_LIMIT,
  MAX_OFFSET,
  MAX_WINDOW_DAYS,
  UNATTRIBUTED_USER_ID,
  usageByUserResponseSchema,
  usageByUserRowSchema,
  usageByUserSeriesPointSchema,
  type UsageByUserOptions,
  type UsageByUserResponse,
  type UsageByUserSeriesPoint,
  type UsageByUserRow,
} from "./domain/observability/usage-by-user.js";
