/**
 * `LensReadClient` — the typed read/write surface of `@usetheo/lens-sdk` (M103).
 *
 * One typed method per route. Responses are typed from the generated OpenAPI
 * (`../__generated__/openapi.ts`) for zod-backed routes, or hand-authored (drift-guarded by a contract
 * test) for the bare-`c.json` routes; requests map a small typed options object to the snake_case query.
 *
 * The shared HTTP transport (constructor, edge-safe URL composition, bounded-retry `send`/`request`,
 * typed error mapping) lives in {@link LensReadTransport} (`./transport.ts`, split out in M117 to keep
 * this file under the size budget). This class extends it and adds one public method per route.
 *
 * Auth is a `theo_live_*` key sent as `Authorization: Bearer <key>`; the per-tenant key resolves the
 * workspace at the edge, so the client NEVER sends a workspace parameter (theo-data invariant 2/3).
 */
import { LensReadTransport } from "./transport.js";
import type {
  AddDatasetItemBody,
  AgentCatalogResponse,
  AnnotateBody,
  AnnotationsResponse,
  AskFeedbackBody,
  Capabilities,
  CopilotFeedbackRecord,
  CostByPeriodOptions,
  CostByPeriodResponse,
  CreateDatasetBody,
  CreateEvaluatorBody,
  CreateExperimentRunBody,
  Dataset,
  DatasetDetail,
  DatasetsResponse,
  EnqueueLabelingBody,
  EvaluatorMetricsResponse,
  EvaluatorRecord,
  EvaluatorUpdateBody,
  ExperimentRun,
  ExportLabelingBody,
  GuardBody,
  GuardRecord,
  LabelingQueueItem,
  LabelingQueuePage,
  ListLabelingQueueOptions,
  ListSessionsOptions,
  ListTracesOptions,
  MetricsRangeOptions,
  NorthStarResponse,
  ObservabilityOptions,
  ObservabilityResponse,
  ReplaySessionAck,
  ReplaySessionBody,
  ReplaySpanBody,
  ReplayResult,
  ResolveLabelingBody,
  RunEvaluatorBody,
  RunResult,
  ScoresResponse,
  SessionDetailResponse,
  SessionListResponse,
  Span,
  SpanAttributesOptions,
  SpanFacetsResponse,
  TagBody,
  ToolStatsResponse,
  TraceCostResponse,
  TraceListResponse,
  TraceTagsResponse,
  UpdateDatasetBody,
} from "./types.js";

// Re-export so existing consumers of `LensReadClientOptions` from `@usetheo/lens-sdk` (and the barrel
// `index.ts`, which imports it from this module) keep resolving after the M117 transport split.
export type { LensReadClientOptions } from "./transport.js";

export class LensReadClient extends LensReadTransport {
  /** `GET /v1/traces` — paginated, filterable trace list. */
  listTraces(options: ListTracesOptions = {}): Promise<TraceListResponse> {
    return this.request<TraceListResponse>("/v1/traces", {
      status: options.status,
      model: options.model,
      limit: options.limit,
      offset: options.offset,
      session_id: options.sessionId,
    });
  }

  /** `GET /v1/spans/{spanId}` — a single enriched span. */
  getSpan(spanId: string): Promise<Span> {
    return this.request<Span>(`/v1/spans/${encodeURIComponent(spanId)}`);
  }

  /** `GET /v1/metrics/observability` — observability time-series + rollups. */
  observability(options: ObservabilityOptions = {}): Promise<ObservabilityResponse> {
    return this.request<ObservabilityResponse>("/v1/metrics/observability", {
      range: options.range,
    });
  }

  /** `GET /v1/sessions` — paginated session list. */
  listSessions(options: ListSessionsOptions = {}): Promise<SessionListResponse> {
    return this.request<SessionListResponse>("/v1/sessions", {
      limit: options.limit,
      offset: options.offset,
    });
  }

  /** `GET /v1/analytics/cost` — cost broken down by period. */
  costByPeriod(options: CostByPeriodOptions = {}): Promise<CostByPeriodResponse> {
    return this.request<CostByPeriodResponse>("/v1/analytics/cost", { period: options.period });
  }

  /** `GET /v1/analytics/tools` — tool-call usage stats. */
  toolStats(): Promise<ToolStatsResponse> {
    return this.request<ToolStatsResponse>("/v1/analytics/tools");
  }

  /** `GET /v1/datasets` — the workspace's datasets, wrapped as `{ datasets: [...] }`. */
  listDatasets(): Promise<DatasetsResponse> {
    return this.request<DatasetsResponse>("/v1/datasets");
  }

  /** `GET /v1` — service discovery: identity, version, and the `/openapi.json` pointer. */
  capabilities(): Promise<Capabilities> {
    return this.request<Capabilities>("/v1");
  }

  // ─── Write surface (M107/M108) — curate datasets + annotate/tag traces. ───
  // These writes pass `retryNetwork: true` because the engine makes them IDEMPOTENT server-side
  // (dataset create-or-get + traceId-item/tag `ON CONFLICT DO NOTHING`, annotation upsert, inherent
  // DELETE, PUT rename), so retrying an ambiguous network/timeout is safe — no double-apply (M108).
  // EXCEPTION: `addDatasetItem` with a synthetic `input` (no `traceId`) is NOT idempotent — see its
  // doc; it passes `retryNetwork:false`. INVARIANT: a NON-idempotent write MUST pass `retryNetwork:false`.

  /** `POST /v1/datasets` — create (or idempotently get) a dataset by name. */
  createDataset(body: CreateDatasetBody): Promise<Dataset> {
    return this.send<Dataset>("POST", "/v1/datasets", { body, retryNetwork: true });
  }

  /** `PUT /v1/datasets/{id}` — rename a dataset (409 `NAME_CONFLICT` if the name is taken). */
  updateDataset(datasetId: string, body: UpdateDatasetBody): Promise<Dataset> {
    return this.send<Dataset>("PUT", `/v1/datasets/${encodeURIComponent(datasetId)}`, {
      body,
      retryNetwork: true,
    });
  }

  /** `DELETE /v1/datasets/{id}` — delete a dataset (204 → void). */
  deleteDataset(datasetId: string): Promise<void> {
    return this.send<void>("DELETE", `/v1/datasets/${encodeURIComponent(datasetId)}`, {
      retryNetwork: true,
    });
  }

  /**
   * `POST /v1/datasets/{id}/items` — add a captured trace and/or a synthetic input/output pair.
   *
   * Idempotency is body-dependent (mirrors the engine's dispatch): a `traceId` item is idempotent
   * (`ON CONFLICT DO NOTHING`) → network-retryable; a SYNTHETIC item (`input`, no `traceId`) is NOT —
   * the engine mints a fresh `replay-<uuid>` per call, so a lost-response retry would double-insert.
   * The synthetic path therefore passes `retryNetwork:false` (a network/timeout is surfaced, not retried).
   */
  addDatasetItem(datasetId: string, body: AddDatasetItemBody): Promise<DatasetDetail> {
    const idempotent = typeof body.traceId === "string" && body.traceId.length > 0;
    return this.send<DatasetDetail>("POST", `/v1/datasets/${encodeURIComponent(datasetId)}/items`, {
      body,
      retryNetwork: idempotent,
    });
  }

  /** `DELETE /v1/datasets/{id}/items/{traceId}` — remove an item; returns the updated detail. */
  removeDatasetItem(datasetId: string, traceId: string): Promise<DatasetDetail> {
    return this.send<DatasetDetail>(
      "DELETE",
      `/v1/datasets/${encodeURIComponent(datasetId)}/items/${encodeURIComponent(traceId)}`,
      { retryNetwork: true },
    );
  }

  /** `POST /v1/traces/{traceId}/annotations` — add an annotation (label and/or note). */
  annotateTrace(traceId: string, body: AnnotateBody): Promise<AnnotationsResponse> {
    return this.send<AnnotationsResponse>(
      "POST",
      `/v1/traces/${encodeURIComponent(traceId)}/annotations`,
      { body, retryNetwork: true },
    );
  }

  /** `DELETE /v1/traces/{traceId}/annotations` — clear a trace's annotations. */
  deleteAnnotations(traceId: string): Promise<AnnotationsResponse> {
    return this.send<AnnotationsResponse>(
      "DELETE",
      `/v1/traces/${encodeURIComponent(traceId)}/annotations`,
      { retryNetwork: true },
    );
  }

  /** `POST /v1/traces/{traceId}/tags` — add a tag to a trace. */
  tagTrace(traceId: string, body: TagBody): Promise<TraceTagsResponse> {
    return this.send<TraceTagsResponse>("POST", `/v1/traces/${encodeURIComponent(traceId)}/tags`, {
      body,
      retryNetwork: true,
    });
  }

  /** `DELETE /v1/traces/{traceId}/tags?tag=` — remove a tag from a trace. */
  untagTrace(traceId: string, tag: string): Promise<TraceTagsResponse> {
    return this.send<TraceTagsResponse>(
      "DELETE",
      `/v1/traces/${encodeURIComponent(traceId)}/tags`,
      { query: { tag }, retryNetwork: true },
    );
  }

  // ─── Advanced write surface (M111) — evaluators + guards. ───
  // CRUD is idempotent server-side (create/guard upsert on (ws,name); PUT/DELETE inherent) → retryable.
  // EXCEPTION: `runEvaluator` scores spans (billable for llm_judge) → `retryNetwork:false` (M108 lesson).

  /** `POST /v1/evaluators` — create (or upsert-by-name) an evaluator. */
  createEvaluator(body: CreateEvaluatorBody): Promise<EvaluatorRecord> {
    return this.send<EvaluatorRecord>("POST", "/v1/evaluators", { body, retryNetwork: true });
  }

  /** `PUT /v1/evaluators/{id}` — update an evaluator (409 `NAME_CONFLICT` if the name is taken). */
  updateEvaluator(id: string, body: EvaluatorUpdateBody): Promise<EvaluatorRecord> {
    return this.send<EvaluatorRecord>("PUT", `/v1/evaluators/${encodeURIComponent(id)}`, {
      body,
      retryNetwork: true,
    });
  }

  /** `DELETE /v1/evaluators/{id}` — delete an evaluator. */
  deleteEvaluator(id: string): Promise<void> {
    return this.send<void>("DELETE", `/v1/evaluators/${encodeURIComponent(id)}`, {
      retryNetwork: true,
    });
  }

  /**
   * `POST /v1/evaluators/{id}/run` — score spans with an evaluator. NON-idempotent (each run writes
   * fresh verdicts, billable for `llm_judge`) → NOT network-retried, so a lost response never
   * double-scores (M108 lesson).
   */
  runEvaluator(id: string, body: RunEvaluatorBody = {}): Promise<RunResult> {
    return this.send<RunResult>("POST", `/v1/evaluators/${encodeURIComponent(id)}/run`, {
      body,
      retryNetwork: false,
    });
  }

  /** `POST /v1/guards` — create (or upsert) a guard over an evaluator's verdict. */
  createGuard(body: GuardBody): Promise<GuardRecord> {
    return this.send<GuardRecord>("POST", "/v1/guards", { body, retryNetwork: true });
  }

  /** `DELETE /v1/guards/{id}` — delete a guard. */
  deleteGuard(id: string): Promise<void> {
    return this.send<void>("DELETE", `/v1/guards/${encodeURIComponent(id)}`, { retryNetwork: true });
  }

  // ─── Labeling queue + copilot ask-feedback (M112). ───

  /** `POST /v1/traces/{traceId}/enqueue-for-labeling` — queue a span for human review (idempotent). */
  enqueueForLabeling(traceId: string, body: EnqueueLabelingBody): Promise<LabelingQueueItem> {
    return this.send<LabelingQueueItem>(
      "POST",
      `/v1/traces/${encodeURIComponent(traceId)}/enqueue-for-labeling`,
      { body, retryNetwork: true },
    );
  }

  /**
   * `POST /v1/labeling-queue/{itemId}/resolve` — resolve a queue item with a label.
   * Conservative `retryNetwork:false` (a resolve is a state transition whose idempotency under
   * concurrent resolution is not verified here — never auto-retry an ambiguous network failure).
   */
  resolveLabelingItem(itemId: string, body: ResolveLabelingBody): Promise<LabelingQueueItem> {
    return this.send<LabelingQueueItem>(
      "POST",
      `/v1/labeling-queue/${encodeURIComponent(itemId)}/resolve`,
      { body, retryNetwork: false },
    );
  }

  /**
   * `POST /v1/labeling-queue/export-as-dataset` — export resolved items as a golden dataset.
   * Conservative `retryNetwork:false` (it creates + populates a dataset — the create-class risk).
   */
  exportLabelingAsDataset(body: ExportLabelingBody): Promise<Dataset> {
    return this.send<Dataset>("POST", "/v1/labeling-queue/export-as-dataset", {
      body,
      retryNetwork: false,
    });
  }

  /** `POST /v1/traces/{traceId}/ask/feedback` — thumbs up/down on a copilot turn (upsert, idempotent). */
  submitAskFeedback(traceId: string, body: AskFeedbackBody): Promise<CopilotFeedbackRecord> {
    return this.send<CopilotFeedbackRecord>(
      "POST",
      `/v1/traces/${encodeURIComponent(traceId)}/ask/feedback`,
      { body, retryNetwork: true },
    );
  }

  /** `DELETE /v1/traces/{traceId}/ask/feedback?turnId=` — retract a copilot-turn vote (204, idempotent). */
  deleteAskFeedback(traceId: string, turnId: string): Promise<void> {
    return this.send<void>("DELETE", `/v1/traces/${encodeURIComponent(traceId)}/ask/feedback`, {
      query: { turnId },
      retryNetwork: true,
    });
  }

  // ─── Experiment runs + span replay (M113). ───
  // All THREE launch billable provider work → NON-idempotent → `retryNetwork:false`: a lost-response
  // retry would re-run/re-bill (the M108/M94 double-bill class). Never auto-retried.

  /** `POST /v1/experiment-runs` — launch a dataset × variant experiment run (billable, not retried). */
  createExperimentRun(body: CreateExperimentRunBody): Promise<ExperimentRun> {
    return this.send<ExperimentRun>("POST", "/v1/experiment-runs", { body, retryNetwork: false });
  }

  /** `POST /v1/traces/{traceId}/replay` — re-execute an edited message list (billable, not retried). */
  replaySpan(traceId: string, body: ReplaySpanBody): Promise<ReplayResult> {
    return this.send<ReplayResult>("POST", `/v1/traces/${encodeURIComponent(traceId)}/replay`, {
      body,
      retryNetwork: false,
    });
  }

  /** `POST /v1/replay-sessions` — record a replay-open event (not retried — avoid double-counting). */
  createReplaySession(body: ReplaySessionBody): Promise<ReplaySessionAck> {
    return this.send<ReplaySessionAck>("POST", "/v1/replay-sessions", {
      body,
      retryNetwork: false,
    });
  }

  // ─── M117 read parity — GENERATED (zod-backed) reads. ───
  // Idempotent GETs → the `request` default (retryNetwork:true). Every path is engine-relative so the
  // #49 basePath swap composes /v1/lens/... with no per-method work. Types are drift-gated aliases.

  /** `GET /v1/traces/{traceId}/cost` — the trace's cost rollup. */
  getTraceCost(traceId: string): Promise<TraceCostResponse> {
    return this.request<TraceCostResponse>(`/v1/traces/${encodeURIComponent(traceId)}/cost`);
  }

  /** `GET /v1/traces/{traceId}/tags` — a trace's current tags (read side of tag/untag). */
  listTraceTags(traceId: string): Promise<TraceTagsResponse> {
    return this.request<TraceTagsResponse>(`/v1/traces/${encodeURIComponent(traceId)}/tags`);
  }

  /** `GET /v1/traces/{traceId}/annotations` — a trace's annotations (read side of annotate/delete). */
  listTraceAnnotations(traceId: string): Promise<AnnotationsResponse> {
    return this.request<AnnotationsResponse>(`/v1/traces/${encodeURIComponent(traceId)}/annotations`);
  }

  /** `GET /v1/agents` — the derived agent catalog `{ agents: [...] }`. */
  getAgents(): Promise<AgentCatalogResponse> {
    return this.request<AgentCatalogResponse>("/v1/agents");
  }

  /** `GET /v1/analytics/tools/{toolName}/traces` — traces that used a given tool. */
  getToolTraces(toolName: string): Promise<TraceListResponse> {
    return this.request<TraceListResponse>(
      `/v1/analytics/tools/${encodeURIComponent(toolName)}/traces`,
    );
  }

  /** `GET /v1/metrics/north-star` — the north-star aggregate. */
  getNorthStar(): Promise<NorthStarResponse> {
    return this.request<NorthStarResponse>("/v1/metrics/north-star");
  }

  /** `GET /v1/metrics/evaluators` — per-evaluator aggregate `{ evaluators: [...] }`. */
  getEvaluatorMetrics(options: MetricsRangeOptions = {}): Promise<EvaluatorMetricsResponse> {
    return this.request<EvaluatorMetricsResponse>("/v1/metrics/evaluators", { range: options.range });
  }

  /** `GET /v1/metrics/scores` — per-evaluator score aggregation over time. */
  getScores(options: MetricsRangeOptions = {}): Promise<ScoresResponse> {
    return this.request<ScoresResponse>("/v1/metrics/scores", { range: options.range });
  }

  /** `GET /v1/metrics/span-attributes` — facet keys (no `key`) or a key's values (`?key=`). */
  getSpanAttributes(options: SpanAttributesOptions = {}): Promise<SpanFacetsResponse> {
    return this.request<SpanFacetsResponse>("/v1/metrics/span-attributes", { key: options.key });
  }

  /** `GET /v1/sessions/{sessionId}` — a single session's detail (its traces). */
  getSession(sessionId: string): Promise<SessionDetailResponse> {
    return this.request<SessionDetailResponse>(`/v1/sessions/${encodeURIComponent(sessionId)}`);
  }

  /** `GET /v1/datasets/{datasetId}` — a dataset + its items (the detail view). */
  getDataset(datasetId: string): Promise<DatasetDetail> {
    return this.request<DatasetDetail>(`/v1/datasets/${encodeURIComponent(datasetId)}`);
  }

  /** `GET /v1/labeling-queue` — the server-paginated queue page (read side of enqueue/resolve). */
  listLabelingQueue(options: ListLabelingQueueOptions = {}): Promise<LabelingQueuePage> {
    return this.request<LabelingQueuePage>("/v1/labeling-queue", {
      page: options.page,
      pageSize: options.pageSize,
      status: options.status,
    });
  }

  /** `GET /v1/labeling-queue/{itemId}` — a single queue item (read side of enqueue/resolve). */
  getLabelingItem(itemId: string): Promise<LabelingQueueItem> {
    return this.request<LabelingQueueItem>(`/v1/labeling-queue/${encodeURIComponent(itemId)}`);
  }
}
