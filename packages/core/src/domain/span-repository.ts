import type { Span } from "./span.js";
import type { ListTracesOptions, TraceListResponse } from "./trace-list.js";
import type { CostByPeriodResponse, CostPeriod, TraceCost } from "./cost.js";
import type { ToolStatsResponse } from "./tool-stats.js";
import type { NorthStarResponse } from "./north-star.js";
import type { ObservabilityRange, ObservabilityResponse } from "./observability.js";
import type { SessionListResponse, SessionDetailResponse } from "./session.js";
import type { PruneStats } from "./retention.js";
import type { EvaluatorSummary, ScoreBucket } from "./evaluation.js";
import type { Annotation, NormalizedAnnotation } from "./annotation.js";
import type { Dataset, DatasetDetail } from "./dataset.js";
import type {
  LabelingQueueItem,
  LabelingQueuePage,
  LabelingQueueStatus,
  NormalizedResolution,
} from "./labeling-queue.js";
import type { ExperimentRun, ExperimentRunItem, RunVariant } from "./experiment.js";
import type { RunStatus } from "./experiment.js";
import type { Agent } from "./agent-catalog.js";
import type { AskFeedbackInput, CopilotFeedbackRecord } from "./copilot-feedback.js";

/** A span plus its reconstructed children — the trace tree node. */
export interface TraceTreeNode extends Span {
  children: TraceTreeNode[];
}

/**
 * Persistence port for spans (DIP). The domain declares the contract; the
 * infrastructure layer (Drizzle/Postgres) implements it.
 */
export interface SpanRepository {
  // M22: every method takes an optional `workspaceId` (defaults to the `default`
  // workspace → single-tenant behavior unchanged). Reads/deletes scope by it;
  // `save` binds it on insert. The route layer passes the Principal's workspace.
  /** Persist a batch of spans and recompute the trace/session aggregates. */
  save(spans: Span[], workspaceId?: string): Promise<void>;
  /** Read a single span by its spanId, or null if absent. */
  getBySpanId(spanId: string, workspaceId?: string): Promise<Span | null>;
  /** Reconstruct the tree of spans sharing a trace_id, or null if none exist. */
  getTraceTree(traceId: string, workspaceId?: string): Promise<TraceTreeNode | null>;
  /**
   * List executions (traces) as the stable UI list DTO (M3 D2). With no options,
   * newest-first by updated_at (legacy behavior). With options (M9): whitelisted
   * filter (status/model/time) + sort (recent/latency/tokens/cost, dir) + limit.
   */
  listTraces(opts?: ListTracesOptions, workspaceId?: string): Promise<TraceListResponse>;
  /** Per-trace cost summary (M5), or null if the trace is absent. */
  getTraceCost(traceId: string, workspaceId?: string): Promise<TraceCost | null>;
  /** Cost aggregated into day/week time buckets (M5). */
  aggregateCostByPeriod(period: CostPeriod, workspaceId?: string): Promise<CostByPeriodResponse>;
  /** Per-tool operational stats (count/p50/p95/error-rate) over a recent window (M6). */
  aggregateToolStats(workspaceId?: string): Promise<ToolStatsResponse>;
  /** Executions (traces) that called a given tool, newest-first (M6 drill-down). */
  listTracesForTool(toolName: string, limit?: number, workspaceId?: string): Promise<TraceListResponse>;
  /** Record that a trace's replay was opened in the UI (M8 north-star). */
  recordReplaySession(traceId: string, workspaceId?: string): Promise<void>;
  /** North-star metrics: traces ingested per day + replay sessions per week (M8). */
  aggregateNorthStar(workspaceId?: string): Promise<NorthStarResponse>;
  /** Time-series observability over a range: traffic+error-rate, latency percentiles, tokens/cost by model (M11). */
  aggregateObservability(range: ObservabilityRange, workspaceId?: string): Promise<ObservabilityResponse>;
  /** M26: per-evaluator aggregate (count, avg score, label distribution) within the range window. */
  aggregateEvaluators(range: ObservabilityRange, workspaceId?: string): Promise<EvaluatorSummary[]>;
  /** M90: per-evaluator score aggregation bucketed over time (mean + label counts per period).
   *  Only buckets with ≥ 1 sample are returned (no fabricated zero period). */
  aggregateScoresOverTime(range: ObservabilityRange, workspaceId?: string): Promise<ScoreBucket[]>;
  /** Sessions newest-first with per-session scoped aggregates (M13). M81: server-paginated (limit/offset)
   *  with a workspace-scoped total. */
  listSessions(workspaceId?: string, opts?: { limit?: number; offset?: number }): Promise<SessionListResponse>;
  /** One session's scoped aggregates + member traces (M13), or null if absent. */
  getSessionDetail(sessionId: string, workspaceId?: string): Promise<SessionDetailResponse | null>;
  /** Add a tag to a trace (M14, idempotent). Returns false if the trace is absent. */
  addTag(traceId: string, tag: string, workspaceId?: string): Promise<boolean>;
  /** Remove a tag from a trace (M14, idempotent — no-op if absent). */
  removeTag(traceId: string, tag: string, workspaceId?: string): Promise<void>;
  /** A trace's tags, ordered (M14); empty when the trace has none. */
  listTags(traceId: string, workspaceId?: string): Promise<string[]>;
  /**
   * Upsert a human annotation on a trace (`spanId` undefined) or span (M26b).
   * Idempotent on (trace, span, name, annotatorKind) — re-submitting replaces
   * label/note/updatedAt (latest wins). Returns false if the trace is absent (→ 404).
   */
  upsertAnnotation(traceId: string, ann: NormalizedAnnotation, workspaceId?: string): Promise<boolean>;
  /** A trace's annotations (trace-level + all spans'), newest-first (M26b); empty when none. */
  listAnnotations(traceId: string, workspaceId?: string): Promise<Annotation[]>;
  /** Remove an annotation by its target+channel key (M26b, idempotent — no-op if absent). */
  removeAnnotation(
    traceId: string,
    key: { spanId?: string; name: string; annotatorKind?: string },
    workspaceId?: string,
  ): Promise<void>;
  /** Create a dataset, or return the existing one with the same name (M26d, idempotent). */
  createDataset(name: string, workspaceId?: string): Promise<Dataset>;
  /** All datasets with their item counts, newest-first (M26d); empty when none. */
  listDatasets(workspaceId?: string): Promise<Dataset[]>;
  /** A dataset + its items (newest-first), or null if absent (M26d). */
  getDataset(datasetId: string, workspaceId?: string): Promise<DatasetDetail | null>;
  /**
   * Add a trace to a dataset (M26d), snapshotting its root input/output at add-time.
   * Idempotent on (dataset, trace) — keeps the first snapshot. Returns false if the
   * dataset OR the trace is absent (→ 404).
   */
  addDatasetItem(datasetId: string, traceId: string, workspaceId?: string): Promise<boolean>;
  /**
   * Add a SYNTHETIC dataset item (M55): input/output supplied directly (from a playground replay),
   * with no source trace (trace_id NULL). Returns false if the dataset is absent (→ 404).
   */
  addSyntheticDatasetItem(datasetId: string, input: string, output: string, workspaceId?: string): Promise<boolean>;
  /** Remove a dataset item by (dataset, trace) (M26d, idempotent — no-op if absent). */
  removeDatasetItem(datasetId: string, traceId: string, workspaceId?: string): Promise<void>;
  /** M82: rename a dataset. Returns the updated dataset, null if absent; throws NameConflictError on a duplicate name. */
  renameDataset(datasetId: string, newName: string, workspaceId?: string): Promise<Dataset | null>;
  /** M82: delete a dataset + cascade its items and experiment runs (one tx). Idempotent; false if absent. */
  deleteDataset(datasetId: string, workspaceId?: string): Promise<boolean>;
  /**
   * M83: record copilot answer feedback (thumbs up/down). UPSERTs on (workspace, trace, turnId) so a
   * re-vote toggles the label instead of duplicating. Returns the persisted record.
   */
  recordAskFeedback(traceId: string, input: AskFeedbackInput, workspaceId?: string): Promise<CopilotFeedbackRecord>;
  /** M83: retract feedback for a turn (the UI "clear"). Idempotent; false if there was no vote. */
  deleteAskFeedback(traceId: string, turnId: string, workspaceId?: string): Promise<boolean>;
  /**
   * Enqueue a span for human labeling (M63). Idempotent on (workspace, trace, span) — a second
   * enqueue of the same span returns the existing item (ON CONFLICT DO NOTHING). Returns the item.
   */
  enqueueLabelingItem(
    traceId: string,
    spanId: string,
    createdBy: string,
    workspaceId?: string,
  ): Promise<LabelingQueueItem>;
  /** A workspace's labeling-queue items, newest-first, server-paginated + optionally status-filtered (M63). */
  listLabelingQueue(
    opts: { status?: LabelingQueueStatus; page?: number; pageSize?: number },
    workspaceId?: string,
  ): Promise<LabelingQueuePage>;
  /** One labeling-queue item by id, or null if absent / another workspace (M63). */
  getLabelingQueueItem(itemId: string, workspaceId?: string): Promise<LabelingQueueItem | null>;
  /**
   * Resolve a labeling-queue item (M63): write the label/score/note, stamp the resolver + version,
   * flip `pending → resolved`. Returns false if the item is absent / another workspace (→ 404).
   */
  resolveLabelingItem(
    itemId: string,
    resolution: NormalizedResolution,
    resolvedBy: string,
    workspaceId?: string,
  ): Promise<boolean>;
  /**
   * Export the workspace's RESOLVED queue items as a golden dataset (M63): create-or-get the named
   * dataset (reuses M44) + add each resolved item's trace. `workspace_id` carried. Returns the dataset.
   */
  exportResolvedAsDataset(name: string, workspaceId?: string): Promise<Dataset>;
  /**
   * Persist an experiment run + its items (M64). Atomic: the run row (aggregates) + all item rows
   * (output/usage/scores jsonb) in one transaction. `workspace_id`-scoped. Returns the run with items.
   */
  createExperimentRun(
    run: {
      datasetId: string;
      name: string;
      variant: RunVariant;
      status: RunStatus;
      truncated: boolean;
      createdBy: string;
      items: ExperimentRunItem[];
    },
    workspaceId?: string,
  ): Promise<ExperimentRun>;
  /** A workspace's experiment runs (aggregates only, no items), newest-first (M64); empty when none. */
  listExperimentRuns(datasetId: string | undefined, workspaceId?: string): Promise<ExperimentRun[]>;
  /** One run + its items, or null if absent / another workspace (M64). */
  getExperimentRun(runId: string, workspaceId?: string): Promise<ExperimentRun | null>;
  /**
   * Agents catalog (M32): spans grouped by the `agent.name` attribute into per-agent
   * rows (latest-seen, run count, versions, tools, system prompt) with health flags.
   * Derived (no table); only `agent.name`-bearing spans are cataloged. Empty when none.
   */
  aggregateAgents(workspaceId?: string): Promise<Agent[]>;
  /**
   * Hard-delete trace data older than `olderThan` (M23 retention) — trace-granular:
   * every trace with `updated_at < olderThan` and all its spans/tags/replay rows,
   * plus sessions left with no remaining trace. Atomic (single transaction).
   * M22: a SYSTEM-wide retention sweep (operator policy, age-based) — NOT
   * tenant-scoped; retention prunes every workspace by age, by design.
   */
  prune(olderThan: Date): Promise<PruneStats>;
}
