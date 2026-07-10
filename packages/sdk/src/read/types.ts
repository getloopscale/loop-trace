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
 * `GuardRecord`) with no Zod response schema, so there is nothing to generate; the M114 hermetic
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
export type GuardOperator = "lt" | "lte" | "gt" | "gte" | "eq" | "label_eq";
/** Create a flag-only guard over an evaluator's verdict. */
export interface GuardBody {
  evaluatorId: string;
  operator: GuardOperator;
  threshold?: number;
  labelValue?: string;
  enabled?: boolean;
}
/** A stored guard (`enabled` is always emitted by the engine). */
export type GuardRecord = GuardBody & { id: string; createdAt: string; enabled: boolean };
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
/** A labeling-queue item. */
export interface LabelingQueueItem {
  id: string;
  traceId: string;
  spanId: string;
  status: "pending" | "resolved";
  label?: string;
  score?: number;
  note?: string;
  createdBy: string;
  resolvedBy?: string;
  createdAt: string;
  resolvedAt?: string;
}
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
/** One evaluator score on a run item. */
export interface RunScore {
  evaluator: string;
  label?: string;
  score?: number;
}
/** One experiment-run item — the replayed output + usage + scores. */
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
/** The replay output + usage. */
export interface ReplayResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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
