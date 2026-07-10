/**
 * M97 (audit B-M1) — the LabelingQueueRepository role, extracted from the god-adapter into its own
 * file. Pure functions over the shared Drizzle `db` handle (the facade delegates here).
 * `exportResolvedAsDataset` reuses the DatasetRepository role functions directly (same `db`).
 * Behavior-preserving: the SQL + shaping moved verbatim; the labeling integration tests are the proof.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { Dataset } from "../../domain/dataset.js";
import type {
  LabelingQueueItem,
  LabelingQueuePage,
  LabelingQueueStatus,
  NormalizedResolution,
} from "../../domain/labeling-queue.js";
import { DEFAULT_WORKSPACE_ID } from "../../domain/principal.js";
import * as datasetRepo from "./dataset-repository.js";
import { labelingQueueItems } from "./schema.js";
import { isUuid } from "./uuid.js";

function labelingItemRow(r: typeof labelingQueueItems.$inferSelect): LabelingQueueItem {
  return {
    id: r.id,
    traceId: r.traceId,
    spanId: r.spanId,
    status: r.status as LabelingQueueStatus,
    label: r.label ?? undefined,
    score: r.score ?? undefined,
    note: r.note ?? undefined,
    createdBy: r.createdBy,
    resolvedBy: r.resolvedBy ?? undefined,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString(),
  };
}

export async function enqueueLabelingItem(
  db: NodePgDatabase,
  traceId: string,
  spanId: string,
  createdBy: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<LabelingQueueItem> {
  // Idempotent create-or-get on the workspace-leading PARTIAL unique (D1) — one PENDING item per
  // span. Insert-or-nothing (conflict only on a still-pending row), then read back the PENDING row
  // scoped to the workspace (a resolved row from an earlier review cycle is ignored).
  await db
    .insert(labelingQueueItems)
    .values({ traceId, spanId, createdBy, workspaceId })
    .onConflictDoNothing({
      target: [labelingQueueItems.workspaceId, labelingQueueItems.traceId, labelingQueueItems.spanId],
      where: sql`${labelingQueueItems.status} = 'pending'`,
    });
  const rows = await db
    .select()
    .from(labelingQueueItems)
    .where(
      and(
        eq(labelingQueueItems.workspaceId, workspaceId),
        eq(labelingQueueItems.traceId, traceId),
        eq(labelingQueueItems.spanId, spanId),
        eq(labelingQueueItems.status, "pending"),
      ),
    )
    .orderBy(desc(labelingQueueItems.createdAt))
    .limit(1);
  return labelingItemRow(rows[0]!);
}

export async function listLabelingQueue(
  db: NodePgDatabase,
  opts: { status?: LabelingQueueStatus; page?: number; pageSize?: number },
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<LabelingQueuePage> {
  // Whitelisted pagination (bounded page size) + always workspace-scoped (never leaks cross-tenant).
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.floor(opts.pageSize ?? 50)));
  const where = opts.status
    ? and(eq(labelingQueueItems.workspaceId, workspaceId), eq(labelingQueueItems.status, opts.status))
    : eq(labelingQueueItems.workspaceId, workspaceId);
  const totalRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(labelingQueueItems)
    .where(where);
  const rows = await db
    .select()
    .from(labelingQueueItems)
    .where(where)
    .orderBy(desc(labelingQueueItems.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  return { items: rows.map((r) => labelingItemRow(r)), total: totalRows[0]?.n ?? 0, page, pageSize };
}

export async function getLabelingQueueItem(
  db: NodePgDatabase,
  itemId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<LabelingQueueItem | null> {
  if (!isUuid(itemId)) return null; // non-uuid path param → absent, not a 500
  const rows = await db
    .select()
    .from(labelingQueueItems)
    .where(and(eq(labelingQueueItems.id, itemId), eq(labelingQueueItems.workspaceId, workspaceId)))
    .limit(1);
  return rows[0] ? labelingItemRow(rows[0]) : null;
}

export async function resolveLabelingItem(
  db: NodePgDatabase,
  itemId: string,
  resolution: NormalizedResolution,
  resolvedBy: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<boolean> {
  if (!isUuid(itemId)) return false; // non-uuid → absent (→ 404), never a 500
  const updated = await db
    .update(labelingQueueItems)
    .set({
      status: "resolved",
      label: resolution.label,
      score: resolution.score ?? null,
      note: resolution.note ?? null,
      resolutionVersion: resolution.schemaVersion,
      resolvedBy,
      resolvedAt: new Date(),
    })
    .where(and(eq(labelingQueueItems.id, itemId), eq(labelingQueueItems.workspaceId, workspaceId)))
    .returning({ id: labelingQueueItems.id });
  return updated.length > 0; // false when absent / another workspace (→ 404)
}

export async function exportResolvedAsDataset(
  db: NodePgDatabase,
  name: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<Dataset> {
  // Reuse the M44 dataset store (D4): create-or-get the named dataset, then add each RESOLVED item's
  // trace (idempotent). Every write is workspace-scoped — a golden dataset built from resolved reviews.
  const dataset = await datasetRepo.createDataset(db, name, workspaceId);
  const resolved = await db
    .select({ traceId: labelingQueueItems.traceId })
    .from(labelingQueueItems)
    .where(and(eq(labelingQueueItems.workspaceId, workspaceId), eq(labelingQueueItems.status, "resolved")));
  for (const r of resolved) {
    await datasetRepo.addDatasetItem(db, dataset.id, r.traceId, workspaceId);
  }
  // Re-read for the up-to-date item count.
  return (await datasetRepo.listDatasets(db, workspaceId)).find((d) => d.id === dataset.id) ?? dataset;
}
