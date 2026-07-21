import { fileURLToPath } from "node:url";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import type { Span } from "../../../domain/observability/span.js";
import { DEFAULT_WORKSPACE_ID } from "../../../domain/principal.js";
import * as traceReadRepo from "./trace-read-repository.js";
import * as aggregateRepo from "./aggregate-repository.js";
import * as annotationRepo from "./annotation-repository.js";
import * as retentionRepo from "../retention-repository.js";
import * as sessionRepo from "./session-repository.js";
import * as copilotFeedbackRepo from "../evaluation/copilot-feedback-repository.js";
import * as experimentRepo from "../evaluation/experiment-repository.js";
import * as datasetRepo from "../evaluation/dataset-repository.js";
import * as labelingRepo from "../evaluation/labeling-queue-repository.js";
import type { AskFeedbackInput, CopilotFeedbackRecord } from "../../../domain/evaluation/copilot-feedback.js";
import type {
  SpanRepository,
  TraceTreeNode } from "../../../domain/observability/span-repository.js";
import type {
  ListTracesOptions,
  TraceListResponse } from "../../../domain/observability/trace-list.js";
import type {
  LabelingQueueItem,
  LabelingQueuePage,
  LabelingQueueStatus,
  NormalizedResolution } from "../../../domain/evaluation/labeling-queue.js";
import type { ExperimentRun } from "../../../domain/evaluation/experiment.js";
import {  type PriceTable } from "../../../domain/observability/pricing.js";
import { DEFAULT_PRICES } from "../../../domain/observability/default-prices.js";
import type {
  CostByPeriodResponse,
  CostPeriod,
  TraceCost } from "../../../domain/observability/cost.js";
import {   type ToolStatsResponse } from "../../../domain/observability/tool-stats.js";
import { parsePoolConfig, type PoolConfig } from "../../../domain/evaluation/evaluator-config.js";
import {
      type NorthStarResponse } from "../../../domain/observability/north-star.js";
import {
      type ObservabilityRange,
  type ObservabilityResponse } from "../../../domain/observability/observability.js";
import {
    type SessionListResponse,
  type SessionDetailResponse } from "../../../domain/observability/session.js";
import type { PruneStats } from "../../../domain/observability/retention.js";
import type { EvaluatorSummary, ScoreBucket } from "../../../domain/evaluation/evaluation.js";
import type { SpanAttributeKey, SpanAttributeValue } from "../../../domain/observability/span-facets.js";
import type { Annotation, NormalizedAnnotation } from "../../../domain/observability/annotation.js";
import type { Dataset, DatasetDetail } from "../../../domain/evaluation/dataset.js";
import {  type Agent } from "../../../domain/observability/agent-catalog.js";

/** Build a pg connection pool for the given Postgres URI. M94: the pool carries resilience config
 *  (max + connect/idle/statement/query timeouts) so a stuck query self-aborts and frees its
 *  connection, and a burst cannot exhaust DB connections. Defaults from `parsePoolConfig` (env-tunable). */
export function createPool(connectionString: string, config: PoolConfig = parsePoolConfig()): pg.Pool {
  const pool = new pg.Pool({ connectionString, ...config });
  // M94 — an idle-client error (e.g. Postgres restarts / the network drops) emits a pool `error`
  // event; WITHOUT a handler, node-pg re-throws it as an uncaught exception and CRASHES the process.
  // We log it and let the pool evict the dead client — so a DB outage degrades to /ready 503 with the
  // process ALIVE (the whole point of the readiness probe), never a crash. (Caught by the M94 live-smoke.)
  pool.on("error", (err) => {
    console.error(
      JSON.stringify({ level: "error", msg: "pg pool idle-client error (non-fatal)", error: err.message }),
    );
  });
  return pool;
}


export class DrizzleSpanRepository implements SpanRepository {
  constructor(
    private readonly db: NodePgDatabase,
    // Configurable per-model price table (M5 ADR D1 — injectable for risk #1).
    private readonly priceTable: PriceTable = DEFAULT_PRICES,
  ) {}

  // M99 (B-M1) — the TraceReadRepository role now lives in `trace-read-repository.ts`.
  save(spansToSave: Span[], workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<void> {
    return traceReadRepo.save(this.db, this.priceTable, spansToSave, workspaceId);
  }
  getBySpanId(spanId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<Span | null> {
    return traceReadRepo.getBySpanId(this.db, spanId, workspaceId);
  }
  getTraceTree(traceId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<TraceTreeNode | null> {
    return traceReadRepo.getTraceTree(this.db, traceId, workspaceId);
  }
  listTraces(opts: ListTracesOptions = {}, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<TraceListResponse> {
    return traceReadRepo.listTraces(this.db, opts, workspaceId);
  }
  getTraceCost(traceId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<TraceCost | null> {
    return traceReadRepo.getTraceCost(this.db, traceId, workspaceId);
  }

  listTracesForTool(toolName: string, limit = 50, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<TraceListResponse> {
    return traceReadRepo.listTracesForTool(this.db, toolName, limit, workspaceId);
  }
  // M99 (B-M1) — the AggregateRepository role now lives in `aggregate-repository.ts`.
  aggregateCostByPeriod(period: CostPeriod, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<CostByPeriodResponse> {
    return aggregateRepo.aggregateCostByPeriod(this.db, period, workspaceId);
  }

  aggregateToolStats(workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<ToolStatsResponse> {
    return aggregateRepo.aggregateToolStats(this.db, workspaceId);
  }

  recordReplaySession(traceId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<void> {
    return aggregateRepo.recordReplaySession(this.db, traceId, workspaceId);
  }

  aggregateNorthStar(workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<NorthStarResponse> {
    return aggregateRepo.aggregateNorthStar(this.db, workspaceId);
  }

  aggregateObservability(range: ObservabilityRange, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<ObservabilityResponse> {
    return aggregateRepo.aggregateObservability(this.db, this.priceTable, range, workspaceId);
  }

  aggregateEvaluators(range: ObservabilityRange, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<EvaluatorSummary[]> {
    return aggregateRepo.aggregateEvaluators(this.db, range, workspaceId);
  }

  aggregateScoresOverTime(range: ObservabilityRange, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<ScoreBucket[]> {
    return aggregateRepo.aggregateScoresOverTime(this.db, range, workspaceId);
  }

  discoverSpanAttributeKeys(workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<SpanAttributeKey[]> {
    return aggregateRepo.discoverSpanAttributeKeys(this.db, workspaceId);
  }

  discoverSpanAttributeValues(key: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<SpanAttributeValue[]> {
    return aggregateRepo.discoverSpanAttributeValues(this.db, key, workspaceId);
  }


  // M99 (B-M1) — the SessionRepository role now lives in `session-repository.ts`.
  listSessions(workspaceId: string = DEFAULT_WORKSPACE_ID, opts: { limit?: number; offset?: number } = {}): Promise<SessionListResponse> {
    return sessionRepo.listSessions(this.db, workspaceId, opts);
  }

  getSessionDetail(sessionId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<SessionDetailResponse | null> {
    return sessionRepo.getSessionDetail(this.db, sessionId, workspaceId);
  }

  // M99 (B-M1) — the AnnotationRepository role now lives in `annotation-repository.ts`; the facade
  // delegates over the shared `db` handle. Behavior unchanged (SQL moved verbatim).
  addTag(traceId: string, tag: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<boolean> {
    return annotationRepo.addTag(this.db, traceId, tag, workspaceId);
  }

  removeTag(traceId: string, tag: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<void> {
    return annotationRepo.removeTag(this.db, traceId, tag, workspaceId);
  }

  listTags(traceId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<string[]> {
    return annotationRepo.listTags(this.db, traceId, workspaceId);
  }

  upsertAnnotation(traceId: string, ann: NormalizedAnnotation, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<boolean> {
    return annotationRepo.upsertAnnotation(this.db, traceId, ann, workspaceId);
  }

  listAnnotations(traceId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<Annotation[]> {
    return annotationRepo.listAnnotations(this.db, traceId, workspaceId);
  }

  removeAnnotation(
    traceId: string,
    key: { spanId?: string; name: string; annotatorKind?: string },
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<void> {
    return annotationRepo.removeAnnotation(this.db, traceId, key, workspaceId);
  }

  // ── M26d datasets ──────────────────────────────────────────────────────────

  /** Map a datasets row (+ item count) to the DTO. */
  // M97 (B-M1) — the DatasetRepository role now lives in `dataset-repository.ts`; the facade
  // delegates over the shared `db` handle. Behavior unchanged (the SQL/shaping moved verbatim).
  createDataset(name: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<Dataset> {
    return datasetRepo.createDataset(this.db, name, workspaceId);
  }

  listDatasets(workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<Dataset[]> {
    return datasetRepo.listDatasets(this.db, workspaceId);
  }

  getDataset(datasetId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<DatasetDetail | null> {
    return datasetRepo.getDataset(this.db, datasetId, workspaceId);
  }

  addDatasetItem(datasetId: string, traceId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<boolean> {
    return datasetRepo.addDatasetItem(this.db, datasetId, traceId, workspaceId);
  }

  addSyntheticDatasetItem(
    datasetId: string,
    input: string,
    output: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<boolean> {
    return datasetRepo.addSyntheticDatasetItem(this.db, datasetId, input, output, workspaceId);
  }

  removeDatasetItem(datasetId: string, traceId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<void> {
    return datasetRepo.removeDatasetItem(this.db, datasetId, traceId, workspaceId);
  }

  renameDataset(datasetId: string, newName: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<Dataset | null> {
    return datasetRepo.renameDataset(this.db, datasetId, newName, workspaceId);
  }

  deleteDataset(datasetId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<boolean> {
    return datasetRepo.deleteDataset(this.db, datasetId, workspaceId);
  }

  // ── M83 copilot answer feedback ──────────────────────────────────────────────

  // M99 (B-M1) — the CopilotFeedbackRepository role now lives in `copilot-feedback-repository.ts`.
  recordAskFeedback(traceId: string, input: AskFeedbackInput, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<CopilotFeedbackRecord> {
    return copilotFeedbackRepo.recordAskFeedback(this.db, traceId, input, workspaceId);
  }

  deleteAskFeedback(traceId: string, turnId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<boolean> {
    return copilotFeedbackRepo.deleteAskFeedback(this.db, traceId, turnId, workspaceId);
  }

  // ── M63 labeling queues ──────────────────────────────────────────────────────

  /** Map a labeling_queue_items row to the API DTO (nullable columns → optional/undefined). */
  // M97 (B-M1) — the LabelingQueueRepository role now lives in `labeling-queue-repository.ts`; the
  // facade delegates over the shared `db` handle. Behavior unchanged (SQL/shaping moved verbatim).
  enqueueLabelingItem(
    traceId: string,
    spanId: string,
    createdBy: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<LabelingQueueItem> {
    return labelingRepo.enqueueLabelingItem(this.db, traceId, spanId, createdBy, workspaceId);
  }

  listLabelingQueue(
    opts: { status?: LabelingQueueStatus; page?: number; pageSize?: number },
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<LabelingQueuePage> {
    return labelingRepo.listLabelingQueue(this.db, opts, workspaceId);
  }

  getLabelingQueueItem(itemId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<LabelingQueueItem | null> {
    return labelingRepo.getLabelingQueueItem(this.db, itemId, workspaceId);
  }

  resolveLabelingItem(
    itemId: string,
    resolution: NormalizedResolution,
    resolvedBy: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<boolean> {
    return labelingRepo.resolveLabelingItem(this.db, itemId, resolution, resolvedBy, workspaceId);
  }

  exportResolvedAsDataset(name: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<Dataset> {
    return labelingRepo.exportResolvedAsDataset(this.db, name, workspaceId);
  }

  // ── M64 experiment runs ──────────────────────────────────────────────────────

  /** Map an experiment_runs row to the API DTO (nullable columns → optional/undefined). */
  // M97 (B-M1) — the ExperimentRepository role now lives in `experiment-repository.ts`; the facade
  // delegates over the shared `db` handle. Behavior unchanged (the SQL/shaping moved verbatim).
  createExperimentRun(
    run: Parameters<typeof experimentRepo.createExperimentRun>[1],
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<ExperimentRun> {
    return experimentRepo.createExperimentRun(this.db, run, workspaceId);
  }

  listExperimentRuns(
    datasetId: string | undefined,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<ExperimentRun[]> {
    return experimentRepo.listExperimentRuns(this.db, datasetId, workspaceId);
  }

  getExperimentRun(runId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<ExperimentRun | null> {
    return experimentRepo.getExperimentRun(this.db, runId, workspaceId);
  }

  aggregateAgents(workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<Agent[]> {
    return aggregateRepo.aggregateAgents(this.db, workspaceId);
  }

  // M99 (B-M1) — the RetentionRepository role now lives in `retention-repository.ts`.
  prune(olderThan: Date): Promise<PruneStats> {
    return retentionRepo.prune(this.db, olderThan);
  }
}

export function createSpanRepository(connectionString: string): {
  repo: DrizzleSpanRepository;
  pool: pg.Pool;
} {
  const pool = createPool(connectionString);
  const db = drizzle(pool);
  return { repo: new DrizzleSpanRepository(db), pool };
}

// This module lives at `infrastructure/db/observability/`, but the Drizzle
// migrations (and copy-migrations.mjs's dist target) live one level up at
// `infrastructure/db/migrations`. Resolve `../migrations` — `./migrations` points
// at a non-existent `observability/migrations` and makes boot fail with
// "Can't find meta/_journal.json" once the dist is rebuilt from this path.
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

/** Apply the committed Drizzle migrations (the real release artifact) to `pool`. */
export async function migrateLatest(pool: pg.Pool): Promise<void> {
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
}

/**
 * Build a span repository from a raw pool.
 *
 * Completes the `…FromPool` convention this package already uses for the
 * evaluator repo and the session-verdict store. Without it, a caller holding a
 * pool has to construct a drizzle instance itself — which means declaring
 * `drizzle-orm` in a package that has no runtime need for it.
 */
export function spanRepoFromPool(pool: pg.Pool): DrizzleSpanRepository {
  return new DrizzleSpanRepository(drizzle(pool));
}
