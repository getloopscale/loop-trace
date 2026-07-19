/**
 * M97 (audit B-M1) — the DatasetRepository role, extracted from the god-adapter into its own file.
 * Pure functions over the shared Drizzle `db` handle (the facade `DrizzleSpanRepository` delegates
 * here). Behavior-preserving: the SQL + shaping moved verbatim; the dataset integration/contract
 * tests are the proof.
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { Dataset, DatasetDetail } from "../../../domain/evaluation/dataset.js";
import { NameConflictError, isForeignKeyViolation, isUniqueViolation } from "../../../domain/errors.js";
import { DEFAULT_WORKSPACE_ID } from "../../../domain/principal.js";
import { isoTimestamp } from "../../../domain/observability/session.js";
import { datasetItems, datasets, experimentRunItems, experimentRuns, spans } from "../schema.js";
import { isUuid } from "../uuid.js";

function datasetRow(r: { id: string; name: string; createdAt: Date; itemCount: number }): Dataset {
  return {
    id: r.id,
    name: r.name,
    createdAt: isoTimestamp(r.createdAt),
    itemCount: r.itemCount,
  };
}

export async function createDataset(
  db: NodePgDatabase,
  name: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<Dataset> {
  // D1: create-or-get on the workspace-leading UNIQUE (idempotent). Insert-or-
  // nothing, then read the row back (just-created or pre-existing) + item count.
  await db
    .insert(datasets)
    .values({ name, workspaceId })
    .onConflictDoNothing({ target: [datasets.workspaceId, datasets.name] });
  const rows = await db
    .select({
      id: datasets.id,
      name: datasets.name,
      createdAt: datasets.createdAt,
      itemCount: sql<number>`count(${datasetItems.id})::int`.as("item_count"),
    })
    .from(datasets)
    .leftJoin(
      datasetItems,
      and(eq(datasetItems.datasetId, datasets.id), eq(datasetItems.workspaceId, datasets.workspaceId)),
    )
    .where(and(eq(datasets.name, name), eq(datasets.workspaceId, workspaceId)))
    .groupBy(datasets.id, datasets.name, datasets.createdAt)
    .limit(1);
  return datasetRow(rows[0]!);
}

export async function listDatasets(
  db: NodePgDatabase,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<Dataset[]> {
  // LEFT JOIN + GROUP BY for the per-dataset item count (a correlated subquery in
  // the projection did not correlate reliably here; the grouped join is idiomatic).
  const rows = await db
    .select({
      id: datasets.id,
      name: datasets.name,
      createdAt: datasets.createdAt,
      itemCount: sql<number>`count(${datasetItems.id})::int`.as("item_count"),
    })
    .from(datasets)
    .leftJoin(
      datasetItems,
      and(eq(datasetItems.datasetId, datasets.id), eq(datasetItems.workspaceId, datasets.workspaceId)),
    )
    .where(eq(datasets.workspaceId, workspaceId))
    .groupBy(datasets.id, datasets.name, datasets.createdAt)
    .orderBy(desc(datasets.createdAt));
  return rows.map((r) => datasetRow(r));
}

export async function getDataset(
  db: NodePgDatabase,
  datasetId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<DatasetDetail | null> {
  if (!isUuid(datasetId)) return null; // non-uuid path param → absent, not a 500
  const dsRows = await db
    .select()
    .from(datasets)
    .where(and(eq(datasets.id, datasetId), eq(datasets.workspaceId, workspaceId)))
    .limit(1);
  const ds = dsRows[0];
  if (!ds) return null;
  const items = await db
    .select()
    .from(datasetItems)
    .where(and(eq(datasetItems.datasetId, datasetId), eq(datasetItems.workspaceId, workspaceId)))
    .orderBy(desc(datasetItems.createdAt));
  return {
    id: ds.id,
    name: ds.name,
    createdAt: isoTimestamp(ds.createdAt),
    items: items.map((i) => ({
      traceId: i.traceId,
      ...(i.inputSnapshot != null ? { inputSnapshot: i.inputSnapshot } : {}),
      ...(i.outputSnapshot != null ? { outputSnapshot: i.outputSnapshot } : {}),
      createdAt: isoTimestamp(i.createdAt),
    })),
  };
}

export async function addDatasetItem(
  db: NodePgDatabase,
  datasetId: string,
  traceId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<boolean> {
  // D2/D3: snapshot the trace's root input/output AT ADD-TIME (durable past prune), idempotent on
  // (dataset, trace). Returns false if the dataset OR the trace is absent in the workspace (→ 404).
  // M101 (B-L3) — the dataset-exists guard + the insert are ONE atomic statement (a CTE), closing the
  // TOCTOU window where a concurrent deleteDataset between a separate SELECT and INSERT would leave an
  // orphan item. The `guard` CTE requires BOTH the dataset and the trace to exist; the insert reads
  // `FROM guard`, so it runs only when they do; the trailing `SELECT ok FROM guard` distinguishes
  // "absent" (0 rows → false) from an ON-CONFLICT no-op on an existing item (1 row → true, idempotent).
  if (!isUuid(datasetId)) return false;
  // The root span (earliest, parent_span_id IS NULL) carries the trace's I/O snapshot values.
  const root = await db
    .select({ input: spans.inputValue, output: spans.outputValue })
    .from(spans)
    .where(and(eq(spans.traceId, traceId), eq(spans.workspaceId, workspaceId), isNull(spans.parentSpanId)))
    .orderBy(asc(sql`${spans.startTimeUnixNano}::numeric`))
    .limit(1);
  const snap = root[0];
  try {
    const res = await db.execute(sql`
      WITH guard AS (
        SELECT 1 AS ok
        WHERE EXISTS (SELECT 1 FROM datasets WHERE id = ${datasetId} AND workspace_id = ${workspaceId})
          AND EXISTS (SELECT 1 FROM traces WHERE trace_id = ${traceId} AND workspace_id = ${workspaceId})
      ),
      ins AS (
        INSERT INTO dataset_items (workspace_id, dataset_id, trace_id, input_snapshot, output_snapshot)
        SELECT ${workspaceId}, ${datasetId}, ${traceId}, ${snap?.input ?? null}, ${snap?.output ?? null}
        FROM guard
        ON CONFLICT (workspace_id, dataset_id, trace_id) DO NOTHING
      )
      SELECT ok FROM guard
    `);
    return res.rows.length > 0;
  } catch (err) {
    // The FK's integrity lock blocked on a concurrent deleteDataset; after it committed the parent was
    // gone → 23503. The honest answer is "the dataset is no longer there" → false (never an orphan, ADR 0003).
    if (isForeignKeyViolation(err)) return false;
    throw err;
  }
}

export async function addSyntheticDatasetItem(
  db: NodePgDatabase,
  datasetId: string,
  input: string,
  output: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<boolean> {
  // M55: a synthetic item from a playground replay — input/output stored directly, sourced by a
  // generated `replay-{uuid}` id (NOT a real trace) so the item stays addressable (view + remove by
  // this id) and the unique index dedups correctly. Each save is a new example (fresh id). Returns
  // false if the dataset is absent in the workspace (→ 404). No source trace to snapshot from.
  if (!isUuid(datasetId)) return false;
  // M101 (B-L3) — dataset-exists guard + insert in ONE atomic CTE (no TOCTOU orphan window). The item
  // carries a fresh `replay-{uuid}` id (never a conflict), so `RETURNING` tells us a row was inserted
  // iff the dataset existed at statement time.
  try {
    const res = await db.execute(sql`
      WITH guard AS (
        SELECT 1 WHERE EXISTS (SELECT 1 FROM datasets WHERE id = ${datasetId} AND workspace_id = ${workspaceId})
      )
      INSERT INTO dataset_items (workspace_id, dataset_id, trace_id, input_snapshot, output_snapshot)
      SELECT ${workspaceId}, ${datasetId}, ${`replay-${randomUUID()}`}, ${input}, ${output}
      FROM guard
      RETURNING trace_id
    `);
    return res.rows.length > 0;
  } catch (err) {
    if (isForeignKeyViolation(err)) return false; // raced a concurrent deleteDataset (ADR 0003)
    throw err;
  }
}

export async function removeDatasetItem(
  db: NodePgDatabase,
  datasetId: string,
  traceId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<void> {
  if (!isUuid(datasetId)) return; // idempotent: a non-uuid id removes nothing
  await db
    .delete(datasetItems)
    .where(
      and(
        eq(datasetItems.datasetId, datasetId),
        eq(datasetItems.traceId, traceId),
        eq(datasetItems.workspaceId, workspaceId),
      ),
    );
}

export async function renameDataset(
  db: NodePgDatabase,
  datasetId: string,
  newName: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<Dataset | null> {
  if (!isUuid(datasetId)) return null; // non-uuid path param → absent, not a 500
  // UPDATE the name (workspace-scoped); a collision with another dataset's name violates the
  // (workspace_id, name) UNIQUE → surface as a typed NameConflictError (route maps to 409, M82 ADR-1).
  let updated: { id: string }[];
  try {
    updated = await db
      .update(datasets)
      .set({ name: newName })
      .where(and(eq(datasets.id, datasetId), eq(datasets.workspaceId, workspaceId)))
      .returning({ id: datasets.id });
  } catch (err) {
    if (isUniqueViolation(err)) throw new NameConflictError("a dataset with that name already exists");
    throw err;
  }
  if (updated.length === 0) return null; // absent (or another workspace's dataset)
  // Read back the full DTO with itemCount (reuse the createDataset LEFT JOIN shape).
  const rows = await db
    .select({
      id: datasets.id,
      name: datasets.name,
      createdAt: datasets.createdAt,
      itemCount: sql<number>`count(${datasetItems.id})::int`.as("item_count"),
    })
    .from(datasets)
    .leftJoin(
      datasetItems,
      and(eq(datasetItems.datasetId, datasets.id), eq(datasetItems.workspaceId, datasets.workspaceId)),
    )
    .where(and(eq(datasets.id, datasetId), eq(datasets.workspaceId, workspaceId)))
    .groupBy(datasets.id, datasets.name, datasets.createdAt)
    .limit(1);
  return rows[0] ? datasetRow(rows[0]) : null;
}

export async function deleteDataset(
  db: NodePgDatabase,
  datasetId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<boolean> {
  if (!isUuid(datasetId)) return false; // idempotent: a non-uuid id deletes nothing
  const exists = await db
    .select({ id: datasets.id })
    .from(datasets)
    .where(and(eq(datasets.id, datasetId), eq(datasets.workspaceId, workspaceId)))
    .limit(1);
  if (exists.length === 0) return false;
  // M82 ADR-2: cascade everything derived from the dataset in ONE transaction (no orphans, no FK):
  // the experiment runs' items → the experiment runs → the dataset items → the dataset. All workspace-scoped.
  await db.transaction(async (tx) => {
    const runIds = await tx
      .select({ id: experimentRuns.id })
      .from(experimentRuns)
      .where(and(eq(experimentRuns.datasetId, datasetId), eq(experimentRuns.workspaceId, workspaceId)));
    if (runIds.length > 0) {
      await tx
        .delete(experimentRunItems)
        .where(
          and(
            inArray(experimentRunItems.runId, runIds.map((r) => r.id)),
            eq(experimentRunItems.workspaceId, workspaceId),
          ),
        );
    }
    await tx
      .delete(experimentRuns)
      .where(and(eq(experimentRuns.datasetId, datasetId), eq(experimentRuns.workspaceId, workspaceId)));
    await tx
      .delete(datasetItems)
      .where(and(eq(datasetItems.datasetId, datasetId), eq(datasetItems.workspaceId, workspaceId)));
    await tx.delete(datasets).where(and(eq(datasets.id, datasetId), eq(datasets.workspaceId, workspaceId)));
  });
  return true;
}
