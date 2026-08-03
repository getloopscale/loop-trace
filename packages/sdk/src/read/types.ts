/**
 * Clean, named response + request types for the read SDK (M103).
 *
 * Response types are RE-EXPORTED aliases over the generated OpenAPI component schemas
 * (`src/__generated__/openapi.ts`, produced by `openapi-typescript` — ADR-1) so callers get
 * ergonomic names (`TraceListResponse`) instead of `components["schemas"]["TraceListResponse"]`.
 * The generated file is the single source of truth; a drift gate keeps it honest.
 *
 * Request option types are HAND-WRITTEN: the engine's OpenAPI does not declare query
 * parameters, so the typed option → snake_case query mapping lives in the client. Options are
 * a small, bounded surface (the documented query params in `packages/api/src/server/app.ts`).
 */
import type { components } from "../__generated__/openapi.js";

type Schemas = components["schemas"];

/** `GET /v1/traces` — paginated trace list `{ traces, total, limit, offset }`. */
export type TraceListResponse = Schemas["TraceListResponse"];
/** `GET /v1/spans/{spanId}` — a single enriched span. */
export type Span = Schemas["Span"];
/** `GET /v1/metrics/observability` — the observability time-series + rollups. */
export type ObservabilityResponse = Schemas["ObservabilityResponse"];
/** `GET /v1/sessions` — paginated session list. */
export type SessionListResponse = Schemas["SessionListResponse"];
/** `GET /v1/analytics/cost` — cost broken down by period. */
export type CostByPeriodResponse = Schemas["CostByPeriodResponse"];
/** `GET /v1/analytics/tools` — tool-call usage stats. */
export type ToolStatsResponse = Schemas["ToolStatsResponse"];
/** M140 — token/cost consumption grouped by end user. */
export type UsageByUserResponse = Schemas["UsageByUserResponse"];
/** A single dataset entity. */
export type Dataset = Schemas["Dataset"];
/** `GET /v1/datasets` — the workspace's datasets, wrapped as `{ datasets: Dataset[] }`. */
export type DatasetsResponse = Schemas["DatasetsResponse"];
/** A dataset + its items (the detail view returned by item add/remove). */
export type DatasetDetail = Schemas["DatasetDetail"];
/** `{ tags: string[] }` — a trace's tags after a tag/untag write. */
export type TraceTagsResponse = Schemas["TraceTagsResponse"];
/** `{ annotations: [...] }` — a trace's annotations after an annotate/delete write. */
export type AnnotationsResponse = Schemas["AnnotationsResponse"];

// ─── M117 read parity — GENERATED (zod-backed) response aliases (ADR D1). ───
/** `GET /v1/traces/{id}/cost` — the trace's cost rollup. */
export type TraceCostResponse = Schemas["TraceCostResponse"];
/** `GET /v1/agents` — the derived agent catalog `{ agents: [...] }`. */
export type AgentCatalogResponse = Schemas["AgentCatalogResponse"];
/** `GET /v1/metrics/north-star` — the north-star aggregate. */
export type NorthStarResponse = Schemas["NorthStarResponse"];
/** `GET /v1/metrics/evaluators` — per-evaluator aggregate `{ evaluators: [...] }`. */
export type EvaluatorMetricsResponse = Schemas["EvaluatorsResponse"];
/** `GET /v1/metrics/scores` — per-evaluator score aggregation over time. */
export type ScoresResponse = Schemas["ScoresResponse"];
/** `GET /v1/metrics/span-attributes` — facet keys (no `key`) or values (`?key=`). */
export type SpanFacetsResponse = Schemas["SpanFacetsResponse"];
/** `GET /v1/sessions/{id}` — a single session's detail (traces). */
export type SessionDetailResponse = Schemas["SessionDetailResponse"];
/** `GET /v1/labeling-queue` — a server-paginated queue page `{ items, total, page, pageSize }`. */
export type LabelingQueuePage = Schemas["LabelingQueuePage"];

/** Options for {@link LensReadClient.listTraces} — map to snake_case query params. */
export interface ListTracesOptions {
  status?: string;
  model?: string;
  limit?: number;
  offset?: number;
  /** Wire param `session_id`. */
  sessionId?: string;
}

/** Options for {@link LensReadClient.listSessions}. */
export interface ListSessionsOptions {
  limit?: number;
  offset?: number;
}

/** The rolling window for observability metrics (engine default `24h` when omitted). */
export interface ObservabilityOptions {
  range?: string;
}

/** The aggregation period for cost analytics. */
export interface CostByPeriodOptions {
  period?: string;
}

/**
 * Window + pagination for the consumption-per-end-user read (M140).
 *
 * Every one of these is REJECTED with a typed `400 INVALID_QUERY` above its ceiling — `days` > 365,
 * `limit` > 500, `offset` > 10000 — rather than quietly reduced. That is deliberate: `windowDays` is
 * echoed in the response but `limit` is not, so a silent clamp would hand you a short page while you
 * paged as if it were long.
 */
export interface UsageByUserOptions {
  days?: number;
  limit?: number;
  offset?: number;
}

/** The rolling window for the evaluator/score metric reads (engine default `24h`). */
export interface MetricsRangeOptions {
  range?: string;
}

/** Options for {@link LensReadClient.getSpanAttributes} — omit `key` for the top keys; set it for that key's values. */
export interface SpanAttributesOptions {
  key?: string;
}

/** Options for {@link LensReadClient.listLabelingQueue} — server-paginated + optional status filter. */
export interface ListLabelingQueueOptions {
  page?: number;
  pageSize?: number;
  status?: "pending" | "resolved";
}

/**
 * Request bodies for the write surface (M107). Hand-written (small, 1-3 fields) — the v11 split:
 * responses are generated from the OpenAPI, request bodies are typed interfaces here. The M109
 * hermetic contract test proves each body is accepted by the real engine.
 */
/** Create a dataset by name (idempotent create-or-get). */
export interface CreateDatasetBody {
  name: string;
}
/** Rename a dataset. */
export interface UpdateDatasetBody {
  name: string;
}
/** Add an item to a dataset - a captured trace (`traceId`) and/or a synthetic `input`/`output` pair. */
export interface AddDatasetItemBody {
  traceId?: string;
  input?: string;
  output?: string;
}
/** Annotate a trace - at least one of `label` / `note` is required by the engine. */
export interface AnnotateBody {
  label?: string;
  note?: string;
}
/** Tag a trace with a single tag (1-64 chars). */
export interface TagBody {
  tag: string;
}

/**
 * Evaluators + guards (M111). Hand-written: the engine returns TS-typed records (`EvaluatorRecord`,
 * `MonitorRecord`) with no Zod response schema, so there is nothing to generate; the M114 hermetic
 * contract test proves each type against the real engine.
 */
/** A `rule` evaluator's config — a span-predicate string. */
export interface RuleConfig {
  predicate: string;
}
/** An `llm_judge` evaluator's config — a judge prompt + the pinned model. */
export interface JudgeConfig {
  prompt: string;
  model: string;
}
interface EvaluatorCommon {
  name: string;
  target?: string;
  passLabel?: string;
  failLabel?: string;
  enabled?: boolean;
}
/** The create body — discriminated on `kind`. */
export type CreateEvaluatorBody = EvaluatorCommon &
  ({ kind: "rule"; config: RuleConfig } | { kind: "llm_judge"; config: JudgeConfig });
/**
 * A stored evaluator: the create shape + server-assigned fields. `target`/`enabled` are REQUIRED here
 * (the engine always emits them with defaults applied) even though they are optional in the create body.
 */
export type EvaluatorRecord = CreateEvaluatorBody & {
  id: string;
  createdAt: string;
  target: string;
  enabled: boolean;
};
/** A partial evaluator update (any subset; `kind`+`config` must be provided together). */
export interface EvaluatorUpdateBody {
  name?: string;
  target?: string;
  passLabel?: string;
  failLabel?: string;
  enabled?: boolean;
  kind?: "rule" | "llm_judge";
  config?: RuleConfig | JudgeConfig;
}
/** The comparison a guard applies to an evaluator's verdict. */
export type MonitorOperator = "lt" | "lte" | "gt" | "gte" | "eq" | "label_eq";
/** Create a flag-only guard over an evaluator's verdict. */
export interface MonitorBody {
  evaluatorId: string;
  operator: MonitorOperator;
  threshold?: number;
  labelValue?: string;
  enabled?: boolean;
}
/** A stored guard (`enabled` is always emitted by the engine). */
export type MonitorRecord = MonitorBody & { id: string; createdAt: string; enabled: boolean };
/** Options for {@link LensReadClient.runEvaluator} — scope the run to specific traces / a limit. */
export interface RunEvaluatorBody {
  traceIds?: string[];
  limit?: number;
}
/** The outcome of a `runEvaluator` — how many span verdicts were written / skipped. */
export interface RunResult {
  evaluator: string;
  written: number;
  skipped: number;
  truncated: boolean;
  errors: { spanId: string; reason: string }[];
}

/**
 * Labeling queue + copilot ask-feedback (M112). Hand-written (same rationale as M111 — the M114
 * contract test is the drift guard).
 */
/**
 * A labeling-queue item. GENERATED alias over the engine `labelingQueueItemSchema` (M117 wired it
 * into `RESPONSE_FOR_ROUTE`) — was hand-authored in M112, now drift-gated from the same schema (DRY).
 */
export type LabelingQueueItem = Schemas["LabelingQueueItem"];
/** Enqueue a span for human review. */
export interface EnqueueLabelingBody {
  spanId: string;
}
/** Resolve a labeling-queue item — a non-empty `label` is required. */
export interface ResolveLabelingBody {
  label: string;
  score?: number;
  note?: string;
}
/** Export the resolved labeling items as a golden dataset (by name). */
export interface ExportLabelingBody {
  name: string;
}
/** A copilot ask-feedback vote. */
export type FeedbackLabel = "up" | "down";
/** Submit thumbs-up/down feedback on a copilot answer turn. */
export interface AskFeedbackBody {
  turnId: string;
  label: FeedbackLabel;
}
/** The stored copilot-feedback record (mirrors the engine's `CopilotFeedbackRecord`). */
export interface CopilotFeedbackRecord {
  id: string;
  traceId: string;
  turnId: string;
  spanId?: string;
  label: FeedbackLabel;
  question?: string;
  updatedAt: string;
}

/**
 * Experiment runs + span replay (M113). Hand-written (M111 rationale). These launch billable provider
 * work → the SDK methods are NON-idempotent (`retryNetwork:false`).
 */
/** A run variant — override the model and/or the prompt. */
export interface RunVariant {
  model?: string;
  promptOverride?: string;
}
/** Launch an experiment run of a dataset × a variant. */
export interface CreateExperimentRunBody {
  datasetId: string;
  name: string;
  variant: RunVariant;
}
/** One evaluator score on a run item (mirrors the engine's `runScoreSchema`). */
export interface RunScore {
  name: string;
  score?: number;
  label?: string;
  explanation?: string;
}
/** One experiment-run item — the replayed output + usage + scores (or an error state). */
export interface ExperimentRunItem {
  datasetItemTraceId: string;
  inputSnapshot?: string;
  output?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd?: number;
  latencyMs: number;
  model: string;
  scores: RunScore[];
  error?: string;
}
/** An experiment run + its aggregate scorecard. */
export interface ExperimentRun {
  id: string;
  datasetId: string;
  name: string;
  variant: RunVariant;
  status: "completed" | "partial" | "failed";
  truncated: boolean;
  itemCount: number;
  passCount: number;
  avgScore?: number;
  totalCostUsd: number;
  createdBy: string;
  createdAt: string;
  items?: ExperimentRunItem[];
}
/** A single chat message for a span replay. */
export interface ReplayMessage {
  role: string;
  content: string;
}
/** Re-execute an edited message list against the provider, optionally overriding the model. */
export interface ReplaySpanBody {
  messages: ReplayMessage[];
  model?: string;
}
/** The replay output + usage (the engine's replay handler renames `content`→`output` at the boundary). */
export interface ReplayResult {
  output: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  costUsd?: number;
  model: string;
}
/** Record a replay-open event (analytics). */
export interface ReplaySessionBody {
  traceId: string;
}
/** The ack for a recorded replay-open event. */
export interface ReplaySessionAck {
  recorded: boolean;
}

// ─── M117 read parity — HAND (bare `c.json`, no zod schema) response types (ADR D1). ───
// These 9 routes return a bare `c.json(record)` with no zod DTO to generate from, so the type is
// hand-authored and pinned by the per-method hermetic contract test in
// `read-parity-hand-contract.integration.test.ts` (T2.3 — the drift guard, per D1). Each REUSES an
// existing element type (Span / EvaluatorRecord / MonitorRecord / ExperimentRun) rather than
// re-declaring its fields (DRY). The wrapper key mirrors the engine's `c.json({...})` key exactly (D3).

/**
 * `GET /v1/traces/{traceId}` — the reconstructed trace tree: a {@link Span} plus its recursive
 * children (mirrors the engine `TraceTreeNode extends Span { children: TraceTreeNode[] }`).
 */
// M117→M118: hand-typed pending server-side zod.
export interface TraceTree extends Span {
  children: TraceTree[];
}
/** `GET /v1/evaluators` — `{ evaluators: EvaluatorRecord[] }`. */
// M117→M118: hand-typed pending server-side zod.
export interface ListEvaluatorsResponse {
  evaluators: EvaluatorRecord[];
}
/** `GET /v1/guards` — `{ guards: MonitorRecord[] }`. */
// M117→M118: hand-typed pending server-side zod.
export interface ListGuardsResponse {
  guards: MonitorRecord[];
}
/** `GET /v1/guards/{id}/breaches` — `{ traceIds: string[] }`. */
// M117→M118: hand-typed pending server-side zod.
export interface MonitorBreachesResponse {
  traceIds: string[];
}
/** `GET /v1/experiment-runs` — `{ runs: ExperimentRun[] }`. */
// M117→M118: hand-typed pending server-side zod.
export interface ListExperimentRunsResponse {
  runs: ExperimentRun[];
}
/**
 * The signed run-to-run aggregate deltas (A minus B) — mirrors the core `RunCompareDeltas`
 * (`packages/core/src/domain/experiment.ts:110`); a metric absent on either side yields a `null` delta.
 */
// M117→M118: hand-typed pending server-side zod.
export interface RunCompareDeltas {
  passCountDelta: number;
  passRateDelta: number;
  avgScoreDelta: number | null;
  totalCostDelta: number;
  avgLatencyDelta: number | null;
}
/**
 * `GET /v1/experiment-runs/compare?ids=a,b` — the compared runs (with items) + the signed `deltas` of
 * the first two (`null` when fewer than two ids resolve).
 */
// M117→M118: hand-typed pending server-side zod.
export interface CompareExperimentRunsResponse {
  runs: ExperimentRun[];
  deltas: RunCompareDeltas | null;
}
/**
 * `POST /v1/traces/{traceId}/ask` request — the copilot question (required) + an optional span to
 * anchor it to. Scoped `observability:read` but launches billable provider work.
 */
// M117→M118: hand-typed pending server-side zod.
export interface AskCopilotBody {
  question: string;
  spanId?: string;
}
/** `POST /v1/traces/{traceId}/ask` response — `{ answer }`. */
// M117→M118: hand-typed pending server-side zod.
export interface AskCopilotResponse {
  answer: string;
}

/**
 * The `GET /v1` discovery document — service identity + the machine-contract pointer. Hand-written:
 * `/v1` is intentionally excluded from `/openapi.json` (a discovery/infra route, not a data route),
 * so there is no generated component to alias.
 */
export interface Capabilities {
  service: string;
  version: string;
  capability: string;
  /** Path to the OpenAPI document (relative to the base URL). */
  openapi: string;
  docs: string;
}

/**
 * The M133 async run-job view returned by `POST /v1/evaluators/{id}/run` (202)
 * and `GET /v1/evaluator-run-jobs/{id}`. The SDK polls it internally so
 * `runEvaluator` can keep returning a {@link RunResult}.
 */
export interface EvaluatorRunJobView {
  id: string;
  evaluatorId: string;
  evaluatorName: string;
  status: "queued" | "running" | "completed" | "failed";
  total: number;
  scored: number;
  skipped: number;
  errors: number;
  errorDetails: { spanId: string; reason: string }[];
  truncated: boolean;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}
