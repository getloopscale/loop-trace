/**
 * M97 (audit B-M1) — the ExperimentRepository role, extracted from the god-adapter into its own file.
 * Pure functions over the shared Drizzle `db` handle (the facade `DrizzleSpanRepository` delegates
 * here), so the 2130-LoC adapter no longer carries the experiment surface. Behavior-preserving: the
 * SQL + shaping are moved verbatim; the existing experiment integration/contract tests are the proof.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { aggregateRun } from "../../domain/experiment.js";
import type { ExperimentRun, ExperimentRunItem, RunStatus, RunVariant } from "../../domain/experiment.js";
import { DEFAULT_WORKSPACE_ID } from "../../domain/principal.js";
import { experimentRunItems, experimentRuns } from "./schema.js";
import { isUuid } from "./uuid.js";

function experimentRunRow(r: typeof experimentRuns.$inferSelect, items?: ExperimentRunItem[]): ExperimentRun {
  return {
    id: r.id,
    datasetId: r.datasetId,
    name: r.name,
    variant: r.variant as RunVariant,
    status: r.status as RunStatus,
    truncated: r.truncated,
    itemCount: r.itemCount,
    passCount: r.passCount,
    avgScore: r.avgScore ?? undefined,
    totalCostUsd: r.totalCostUsd,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    ...(items ? { items } : {}),
  };
}

function experimentItemRow(r: typeof experimentRunItems.$inferSelect): ExperimentRunItem {
  return {
    datasetItemTraceId: r.datasetItemTraceId,
    inputSnapshot: r.inputSnapshot ?? undefined,
    output: r.output ?? undefined,
    promptTokens: r.promptTokens,
    completionTokens: r.completionTokens,
    totalTokens: r.totalTokens,
    costUsd: r.costUsd ?? undefined,
    latencyMs: r.latencyMs,
    model: r.model,
    scores: (r.scores as ExperimentRunItem["scores"]) ?? [],
    error: r.error ?? undefined,
  };
}

export async function createExperimentRun(
  db: NodePgDatabase,
  run: {
    datasetId: string;
    name: string;
    variant: RunVariant;
    status: RunStatus;
    truncated: boolean;
    createdBy: string;
    items: ExperimentRunItem[];
  },
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<ExperimentRun> {
  // Compute aggregates from the engine's items (single source of truth) + persist run + items atomically.
  const agg = aggregateRun(run.items);
  const runId = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(experimentRuns)
      .values({
        workspaceId,
        datasetId: run.datasetId,
        name: run.name,
        variant: run.variant,
        status: run.status,
        truncated: run.truncated,
        itemCount: agg.itemCount,
        passCount: agg.passCount,
        avgScore: agg.avgScore ?? null,
        totalCostUsd: agg.totalCostUsd,
        createdBy: run.createdBy,
      })
      .returning({ id: experimentRuns.id });
    const id = inserted[0]!.id;
    if (run.items.length > 0) {
      await tx.insert(experimentRunItems).values(
        run.items.map((it) => ({
          workspaceId,
          runId: id,
          datasetItemTraceId: it.datasetItemTraceId,
          inputSnapshot: it.inputSnapshot ?? null,
          output: it.output ?? null,
          promptTokens: it.promptTokens,
          completionTokens: it.completionTokens,
          totalTokens: it.totalTokens,
          costUsd: it.costUsd ?? null,
          latencyMs: it.latencyMs,
          model: it.model,
          scores: it.scores,
          error: it.error ?? null,
        })),
      );
    }
    return id;
  });
  return (await getExperimentRun(db, runId, workspaceId))!;
}

export async function listExperimentRuns(
  db: NodePgDatabase,
  datasetId: string | undefined,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<ExperimentRun[]> {
  const where =
    datasetId !== undefined
      ? and(eq(experimentRuns.workspaceId, workspaceId), eq(experimentRuns.datasetId, datasetId))
      : eq(experimentRuns.workspaceId, workspaceId);
  const rows = await db.select().from(experimentRuns).where(where).orderBy(desc(experimentRuns.createdAt));
  return rows.map((r) => experimentRunRow(r));
}

export async function getExperimentRun(
  db: NodePgDatabase,
  runId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<ExperimentRun | null> {
  if (!isUuid(runId)) return null; // non-uuid path param → absent, not a 500
  const runs = await db
    .select()
    .from(experimentRuns)
    .where(and(eq(experimentRuns.id, runId), eq(experimentRuns.workspaceId, workspaceId)))
    .limit(1);
  if (!runs[0]) return null;
  const items = await db
    .select()
    .from(experimentRunItems)
    .where(and(eq(experimentRunItems.runId, runId), eq(experimentRunItems.workspaceId, workspaceId)))
    .orderBy(asc(experimentRunItems.createdAt));
  return experimentRunRow(runs[0], items.map((it) => experimentItemRow(it)));
}
