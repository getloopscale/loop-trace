import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { Span } from "../../../domain/observability/span.js";
import { DEFAULT_WORKSPACE_ID } from "../../../domain/principal.js";
import { createPool, DrizzleSpanRepository } from "../observability/drizzle-span-repository.js";

const PG_URI = process.env["LOOPTRACE_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const suite = PG_URI ? describe : describe.skip;

function span(overrides: Partial<Span> & Pick<Span, "spanId" | "traceId">): Span {
  return {
    name: "op",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
    ...overrides,
  };
}

suite("datasets (integration, M26d)", () => {
  let pool: pg.Pool;
  let db: NodePgDatabase;
  let repo: DrizzleSpanRepository;

  beforeAll(async () => {
    pool = createPool(PG_URI as string);
    db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    repo = new DrizzleSpanRepository(db);
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE spans, traces, sessions, replay_sessions, span_evaluations, annotations, dataset_items, datasets, experiment_runs, experiment_run_items",
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("test_create_dataset_idempotent", async () => {
    const a = await repo.createDataset("travel");
    const b = await repo.createDataset("travel"); // create-or-get → same row
    expect(b.id).toBe(a.id);
    expect(b.name).toBe("travel");
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM datasets");
    expect(rows[0].n).toBe(1);
  });

  it("M82 — renameDataset changes the name, keeps id + createdAt", async () => {
    const a = await repo.createDataset("orig");
    const renamed = await repo.renameDataset(a.id, "renamed");
    expect(renamed).not.toBeNull();
    expect(renamed!.id).toBe(a.id);
    expect(renamed!.name).toBe("renamed");
    expect(renamed!.createdAt).toBe(a.createdAt);
    // absent id → null (not a throw)
    expect(await repo.renameDataset("00000000-0000-0000-0000-000000000000", "x")).toBeNull();
    expect(await repo.renameDataset("not-a-uuid", "x")).toBeNull();
  });

  it("M82 — renameDataset to an existing name throws NameConflictError", async () => {
    await repo.createDataset("aaa");
    const b = await repo.createDataset("bbb");
    await expect(repo.renameDataset(b.id, "aaa")).rejects.toThrow(/already exists/i);
  });

  it("M82 — renameDataset is workspace-scoped (cannot rename another tenant's dataset)", async () => {
    const a = await repo.createDataset("shared", "ws-A");
    // ws-B trying to rename ws-A's dataset → null (not found in its scope)
    expect(await repo.renameDataset(a.id, "hijacked", "ws-B")).toBeNull();
    // and ws-A's row is untouched
    const still = await repo.getDataset(a.id, "ws-A");
    expect(still!.name).toBe("shared");
  });

  it("M82 — deleteDataset removes the dataset + its items + experiment runs, atomically + idempotent", async () => {
    await repo.save([span({ spanId: "r1", traceId: "t1", inputValue: "v" })]);
    const ds = await repo.createDataset("golden");
    await repo.addDatasetItem(ds.id, "t1");
    // seed an experiment run + run item on this dataset (direct insert — the cascade must remove them)
    const runIns = await pool.query(
      `INSERT INTO experiment_runs (workspace_id, dataset_id, name, variant, status, truncated, item_count, pass_count, total_cost_usd, created_by, created_at)
       VALUES ($1,$2,'run-1','{}','done',false,1,1,0,'tester',now()) RETURNING id`,
      [DEFAULT_WORKSPACE_ID, ds.id],
    );
    const runId = runIns.rows[0].id as string;
    await pool.query(
      "INSERT INTO experiment_run_items (workspace_id, run_id, dataset_item_trace_id, scores) VALUES ($1,$2,'t1','{}'::jsonb)",
      [DEFAULT_WORKSPACE_ID, runId],
    );
    // delete cascades everything
    expect(await repo.deleteDataset(ds.id)).toBe(true);
    expect(await repo.getDataset(ds.id)).toBeNull();
    const items = await pool.query("SELECT count(*)::int AS n FROM dataset_items WHERE dataset_id=$1", [ds.id]);
    expect(items.rows[0].n).toBe(0);
    const runs = await pool.query("SELECT count(*)::int AS n FROM experiment_runs WHERE dataset_id=$1", [ds.id]);
    expect(runs.rows[0].n).toBe(0);
    const runItems = await pool.query("SELECT count(*)::int AS n FROM experiment_run_items WHERE run_id=$1", [runId]);
    expect(runItems.rows[0].n).toBe(0);
    // idempotent: deleting again is a no-op false, not an error
    expect(await repo.deleteDataset(ds.id)).toBe(false);
    expect(await repo.deleteDataset("not-a-uuid")).toBe(false);
  });

  it("M101 — addDatasetItem to a deleted dataset returns false, inserts nothing (guard gates the insert)", async () => {
    await repo.save([span({ spanId: "r1", traceId: "t1", inputValue: "v" })]);
    const ds = await repo.createDataset("golden");
    expect(await repo.deleteDataset(ds.id)).toBe(true);
    expect(await repo.addDatasetItem(ds.id, "t1")).toBe(false);
    const after = await pool.query("SELECT count(*)::int AS n FROM dataset_items WHERE dataset_id=$1", [ds.id]);
    expect(after.rows[0].n).toBe(0);
  });

  it("M101 — a deleteDataset committing DURING a concurrent addDatasetItem never orphans (deterministic race, ADR 0003)", async () => {
    await repo.save([span({ spanId: "r1", traceId: "t1", inputValue: "v" })]);
    const ds = await repo.createDataset("golden-race");

    // Force the dangerous interleaving deterministically on a SECOND connection: begin a delete tx and
    // hold it (the `DELETE FROM datasets` takes the row's exclusive lock, uncommitted). Then start
    // addDatasetItem on the pool — its guard sees the still-uncommitted dataset (READ COMMITTED), the
    // insert proceeds to the FK integrity check, which BLOCKS on the held lock. Commit the delete →
    // the parent is gone → the blocked insert re-evaluates → FK violation (23503) → addDatasetItem
    // catches it → false. The FK's ON DELETE CASCADE guarantees no orphan for any ordering.
    // (Against the pre-FK code this test is RED: the insert wouldn't block, would commit an item, and
    // the already-run `DELETE dataset_items` would leave it orphaned.)
    const client = await pool.connect();
    let added: boolean;
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM dataset_items WHERE dataset_id = $1", [ds.id]);
      await client.query("DELETE FROM datasets WHERE id = $1", [ds.id]);
      const addP = repo.addDatasetItem(ds.id, "t1"); // blocks on the FK lock
      await new Promise((r) => setTimeout(r, 150)); // let the insert reach the blocked FK check
      await client.query("COMMIT"); // dataset now gone → the blocked insert fails FK
      added = await addP;
    } finally {
      client.release();
    }
    expect(added).toBe(false); // the add honestly reports the dataset is gone
    expect(await repo.getDataset(ds.id)).toBeNull();
    const orphans = await pool.query("SELECT count(*)::int AS n FROM dataset_items WHERE dataset_id = $1", [ds.id]);
    expect(orphans.rows[0].n).toBe(0); // NO orphan survives the concurrent delete
  });

  it("M82 — deleteDataset is workspace-scoped (cannot delete another tenant's dataset)", async () => {
    const a = await repo.createDataset("shared", "ws-A");
    expect(await repo.deleteDataset(a.id, "ws-B")).toBe(false); // ws-B cannot delete ws-A's
    expect(await repo.getDataset(a.id, "ws-A")).not.toBeNull(); // still there
  });

  it("test_add_item_snapshots_trace_io", async () => {
    await repo.save([
      span({ spanId: "r1", traceId: "t1", inputValue: "plan a Rome trip", outputValue: "see the Catacombs" }),
    ]);
    const ds = await repo.createDataset("travel");
    expect(await repo.addDatasetItem(ds.id, "t1")).toBe(true);
    const detail = await repo.getDataset(ds.id);
    expect(detail?.items).toHaveLength(1);
    expect(detail?.items[0]).toMatchObject({
      traceId: "t1",
      inputSnapshot: "plan a Rome trip",
      outputSnapshot: "see the Catacombs",
    });
  });

  it("test_add_item_idempotent_keeps_first_snapshot", async () => {
    await repo.save([span({ spanId: "r1", traceId: "t1", inputValue: "v1" })]);
    const ds = await repo.createDataset("travel");
    await repo.addDatasetItem(ds.id, "t1");
    await repo.addDatasetItem(ds.id, "t1"); // re-add → no duplicate
    const detail = await repo.getDataset(ds.id);
    expect(detail?.items).toHaveLength(1);
  });

  it("test_add_item_absent_dataset_or_trace_false", async () => {
    await repo.save([span({ spanId: "r1", traceId: "t1" })]);
    const ds = await repo.createDataset("travel");
    // unknown (but uuid-shaped) dataset → false
    expect(await repo.addDatasetItem("00000000-0000-0000-0000-000000000000", "t1")).toBe(false);
    // non-uuid dataset id → false (not a 500)
    expect(await repo.addDatasetItem("not-a-uuid", "t1")).toBe(false);
    // unknown trace → false
    expect(await repo.addDatasetItem(ds.id, "ghost")).toBe(false);
  });

  it("test_add_synthetic_item_stores_input_output_with_null_trace (M55 playground replay)", async () => {
    const ds = await repo.createDataset("golden");
    // a synthetic item — no source trace; input/output supplied directly, sourced by a replay- id.
    expect(await repo.addSyntheticDatasetItem(ds.id, "edited prompt", "replayed answer")).toBe(true);
    const detail = await repo.getDataset(ds.id);
    expect(detail?.items).toHaveLength(1);
    expect(detail?.items[0]?.traceId).toMatch(/^replay-/);
    expect(detail?.items[0]).toMatchObject({
      inputSnapshot: "edited prompt",
      outputSnapshot: "replayed answer",
    });
    // two synthetic saves are DISTINCT examples (NULLs distinct in the unique index — no false dedup).
    await repo.addSyntheticDatasetItem(ds.id, "prompt 2", "answer 2");
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM dataset_items WHERE dataset_id = $1", [ds.id]);
    expect(rows[0].n).toBe(2);
  });

  it("test_add_synthetic_item_absent_dataset_false", async () => {
    expect(await repo.addSyntheticDatasetItem("00000000-0000-0000-0000-000000000000", "i", "o")).toBe(false);
    expect(await repo.addSyntheticDatasetItem("not-a-uuid", "i", "o")).toBe(false);
  });

  it("test_list_datasets_with_item_counts", async () => {
    await repo.save([span({ spanId: "r1", traceId: "t1" }), span({ spanId: "r2", traceId: "t2" })]);
    const ds = await repo.createDataset("travel");
    await repo.addDatasetItem(ds.id, "t1");
    await repo.addDatasetItem(ds.id, "t2");
    await repo.createDataset("empty");
    const list = await repo.listDatasets();
    const byName = Object.fromEntries(list.map((d) => [d.name, d.itemCount]));
    expect(byName["travel"]).toBe(2);
    expect(byName["empty"]).toBe(0);
  });

  it("test_prune_leaves_dataset_items", async () => {
    await repo.save([span({ spanId: "old", traceId: "t-old", inputValue: "curated example" })]);
    const ds = await repo.createDataset("travel");
    await repo.addDatasetItem(ds.id, "t-old");
    await pool.query("UPDATE traces SET updated_at = now() - interval '40 days' WHERE trace_id = 't-old'");
    const stats = await repo.prune(new Date());
    expect(stats.tracesDeleted).toBe(1);
    // the curated example SURVIVES the source trace being pruned (D2 — the snapshot is durable)
    const detail = await repo.getDataset(ds.id);
    expect(detail?.items).toHaveLength(1);
    expect(detail?.items[0]?.inputSnapshot).toBe("curated example");
  });

  it("test_remove_dataset_item_idempotent", async () => {
    await repo.save([span({ spanId: "r1", traceId: "t1" })]);
    const ds = await repo.createDataset("travel");
    await repo.addDatasetItem(ds.id, "t1");
    await repo.removeDatasetItem(ds.id, "t1");
    expect((await repo.getDataset(ds.id))?.items).toEqual([]);
    await repo.removeDatasetItem(ds.id, "t1"); // no-op
    expect((await repo.getDataset(ds.id))?.items).toEqual([]);
  });

  it("test_getDataset_absent_returns_null", async () => {
    expect(await repo.getDataset("00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await repo.getDataset("not-a-uuid")).toBeNull(); // garbage id → null, not 500
  });

  it("test_listSessions_carries_evaluations_count", async () => {
    await repo.save([
      span({ spanId: "a1", traceId: "t1", sessionId: "S", evaluations: [{ name: "hallucination", score: 0.2 }] }),
      span({ spanId: "a2", traceId: "t2", sessionId: "S", evaluations: [{ name: "relevance", label: "relevant" }] }),
      span({ spanId: "b1", traceId: "t3", sessionId: "S2" }),
    ]);
    const { sessions } = await repo.listSessions();
    const s = sessions.find((x) => x.sessionId === "S");
    const s2 = sessions.find((x) => x.sessionId === "S2");
    expect(s?.evaluationsCount).toBe(2);
    expect(s2?.evaluationsCount).toBeUndefined(); // 0 → omitted
  });
});
