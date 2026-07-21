/**
 * @usetheo/lens-sdk — instrument a TS/Node agent in ≤10 lines; emit OTLP gen_ai
 * spans to Theo Lens. Thin facade over the OpenTelemetry JS SDK.
 */
export { initTheoLens, type TheoLens, type InitOptions } from "./sdk.js";
export { startAgent, recordToolCall, type AgentSpan } from "./agent-span.js";
export { GEN_AI } from "./attributes.js";

// M103 — the typed READ surface: read traces/metrics/sessions/etc. back via a `theo_live_*` key.
export { LensReadClient, type LensReadClientOptions } from "./read/client.js";
// M104 — the single typed error every read method can throw (switch on `.code`).
export { LensApiError, type FieldIssue } from "./read/errors.js";
export type {
  TraceListResponse,
  Span,
  ObservabilityResponse,
  SessionListResponse,
  CostByPeriodResponse,
  ToolStatsResponse,
  Dataset,
  DatasetsResponse,
  DatasetDetail,
  TraceTagsResponse,
  AnnotationsResponse,
  Capabilities,
  ListTracesOptions,
  ListSessionsOptions,
  ObservabilityOptions,
  CostByPeriodOptions,
  CreateDatasetBody,
  UpdateDatasetBody,
  AddDatasetItemBody,
  AnnotateBody,
  TagBody,
  RuleConfig,
  JudgeConfig,
  CreateEvaluatorBody,
  EvaluatorRecord,
  EvaluatorUpdateBody,
  MonitorOperator,
  MonitorBody,
  MonitorRecord,
  RunEvaluatorBody,
  RunResult,
  LabelingQueueItem,
  EnqueueLabelingBody,
  ResolveLabelingBody,
  ExportLabelingBody,
  FeedbackLabel,
  AskFeedbackBody,
  CopilotFeedbackRecord,
  RunVariant,
  CreateExperimentRunBody,
  RunScore,
  ExperimentRunItem,
  ExperimentRun,
  ReplayMessage,
  ReplaySpanBody,
  ReplayResult,
  ReplaySessionBody,
  ReplaySessionAck,
  // M117 read parity — GENERATED (zod-backed) response aliases + their option types.
  TraceCostResponse,
  AgentCatalogResponse,
  NorthStarResponse,
  EvaluatorMetricsResponse,
  ScoresResponse,
  SpanFacetsResponse,
  SessionDetailResponse,
  LabelingQueuePage,
  MetricsRangeOptions,
  SpanAttributesOptions,
  ListLabelingQueueOptions,
  // M117 read parity — HAND (bare `c.json`) response + request types.
  TraceTree,
  ListEvaluatorsResponse,
  ListGuardsResponse,
  MonitorBreachesResponse,
  ListExperimentRunsResponse,
  RunCompareDeltas,
  CompareExperimentRunsResponse,
  AskCopilotBody,
  AskCopilotResponse,
} from "./read/types.js";

// M115 — ingest the Claude Code / @theokit/sdk `SDKMessage` output: translate a run to OTLP + record it.
export {
  sdkMessagesToOtlp,
  recordRun,
  THEOKIT_SERVICE_NAME,
  type OtlpTraces,
  type SdkMessagesToOtlpOptions,
  type TheokitRun,
  type RecordRunOptions,
} from "./ingest/theokit.js";
export type {
  SDKMessage,
  SDKSystemMessage,
  SDKUserMessageEvent,
  SDKAssistantMessage,
  SDKThinkingMessage,
  SDKToolUseMessage,
  SDKStatusMessage,
  SDKTaskMessage,
  SDKRequestMessage,
  SDKObjectDelta,
  TextBlock as SdkTextBlock,
  ToolUseBlock as SdkToolUseBlock,
  TokenUsage as TheokitTokenUsage,
  CostBreakdown as TheokitCostBreakdown,
  RunResult as TheokitRunResult,
} from "./ingest/sdk-message.js";
