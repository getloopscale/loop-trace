import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { Span } from "../../domain/span.js";
import { createPool, DrizzleSpanRepository } from "./drizzle-span-repository.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("./migrations", import.meta.url));
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
      "TRUNCATE spans, traces, sessions, replay_sessions, span_evaluations, annotations, dataset_items, datasets",
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
