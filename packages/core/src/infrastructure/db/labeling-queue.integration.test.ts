import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { Span } from "../../domain/observability/span.js";
import { normalizeLabelResolution } from "../../domain/labeling-queue.js";
import { createPool, DrizzleSpanRepository } from "./drizzle-span-repository.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("./migrations", import.meta.url));
const suite = PG_URI ? describe : describe.skip;

const WS_A = "ws-a";
const WS_B = "ws-b";

function span(overrides: Partial<Span> & Pick<Span, "spanId" | "traceId">): Span {
  return {
    name: "op",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
    ...overrides,
  };
}

suite("labeling queue write-path (integration, M63)", () => {
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
      "TRUNCATE spans, traces, sessions, replay_sessions, span_evaluations, annotations, datasets, dataset_items, labeling_queue_items",
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("test_enqueue_then_list_is_workspace_scoped (cross-tenant isolation)", async () => {
    await repo.save([span({ spanId: "s1", traceId: "t1" })], WS_A);
    const item = await repo.enqueueLabelingItem("t1", "s1", "reviewer-a", WS_A);
    expect(item.status).toBe("pending");

    // ws-A sees its item; ws-B sees NOTHING — the store is workspace-scoped (invariant 2).
    expect((await repo.listLabelingQueue({}, WS_A)).items).toHaveLength(1);
    expect((await repo.listLabelingQueue({}, WS_B)).items).toHaveLength(0);
    // and ws-B cannot fetch ws-A's item by id (no cross-tenant read).
    expect(await repo.getLabelingQueueItem(item.id, WS_B)).toBeNull();
    expect(await repo.getLabelingQueueItem(item.id, WS_A)).not.toBeNull();
  });

  it("test_enqueue_is_idempotent_while_pending", async () => {
    await repo.save([span({ spanId: "s1", traceId: "t1" })], WS_A);
    const a = await repo.enqueueLabelingItem("t1", "s1", "reviewer-a", WS_A);
    const b = await repo.enqueueLabelingItem("t1", "s1", "reviewer-a", WS_A); // same span again
    expect(b.id).toBe(a.id); // one row, returned both times
    expect((await repo.listLabelingQueue({}, WS_A)).items).toHaveLength(1);
  });

  it("test_resolve_round_trip_and_status_filter", async () => {
    await repo.save([span({ spanId: "s1", traceId: "t1" })], WS_A);
    const item = await repo.enqueueLabelingItem("t1", "s1", "reviewer-a", WS_A);
    const res = normalizeLabelResolution({ label: "good", score: 0.9, note: "clean" })!;
    expect(await repo.resolveLabelingItem(item.id, res, "reviewer-a", WS_A)).toBe(true);

    const resolved = await repo.getLabelingQueueItem(item.id, WS_A);
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.label).toBe("good");
    expect(resolved?.score).toBe(0.9);
    expect(resolved?.resolvedBy).toBe("reviewer-a");
    // status filter: one resolved, zero pending
    expect((await repo.listLabelingQueue({ status: "resolved" }, WS_A)).items).toHaveLength(1);
    expect((await repo.listLabelingQueue({ status: "pending" }, WS_A)).items).toHaveLength(0);
  });

  it("test_resolve_foreign_item_returns_false (no cross-tenant write)", async () => {
    await repo.save([span({ spanId: "s1", traceId: "t1" })], WS_A);
    const item = await repo.enqueueLabelingItem("t1", "s1", "reviewer-a", WS_A);
    const res = normalizeLabelResolution({ label: "good" })!;
    // ws-B tries to resolve ws-A's item → false (absent from B's scope), never mutates it.
    expect(await repo.resolveLabelingItem(item.id, res, "attacker-b", WS_B)).toBe(false);
    expect((await repo.getLabelingQueueItem(item.id, WS_A))?.status).toBe("pending"); // untouched
  });

  it("test_export_builds_a_workspace_scoped_golden_dataset", async () => {
    await repo.save([span({ spanId: "s1", traceId: "t1" })], WS_A);
    const item = await repo.enqueueLabelingItem("t1", "s1", "reviewer-a", WS_A);
    await repo.resolveLabelingItem(item.id, normalizeLabelResolution({ label: "good" })!, "reviewer-a", WS_A);

    const ds = await repo.exportResolvedAsDataset("golden-2026-07", WS_A);
    expect(ds.itemCount).toBe(1); // the resolved item's trace was added

    // ws-A sees the dataset; ws-B does not (workspace-scoped export).
    expect((await repo.listDatasets(WS_A)).some((d) => d.id === ds.id)).toBe(true);
    expect((await repo.listDatasets(WS_B)).some((d) => d.id === ds.id)).toBe(false);
  });

  it("test_concurrent_double_enqueue_yields_one_row (partial UNIQUE race-safe)", async () => {
    await repo.save([span({ spanId: "s1", traceId: "t1" })], WS_A);
    // two concurrent enqueues of the same span → exactly one pending row (DB-atomic UNIQUE + ON CONFLICT).
    await Promise.all([
      repo.enqueueLabelingItem("t1", "s1", "reviewer-a", WS_A),
      repo.enqueueLabelingItem("t1", "s1", "reviewer-a", WS_A),
    ]);
    expect((await repo.listLabelingQueue({}, WS_A)).items).toHaveLength(1);
  });

  it("test_span_can_be_re_enqueued_after_resolve (partial-pending UNIQUE — ADR D1)", async () => {
    // D1: the UNIQUE is partial WHERE status='pending', so a resolved span can be re-enqueued for a
    // FRESH review cycle — a second pending row is created (not deduped against the resolved one).
    await repo.save([span({ spanId: "s1", traceId: "t1" })], WS_A);
    const first = await repo.enqueueLabelingItem("t1", "s1", "reviewer-a", WS_A);
    await repo.resolveLabelingItem(first.id, normalizeLabelResolution({ label: "good" })!, "reviewer-a", WS_A);
    const second = await repo.enqueueLabelingItem("t1", "s1", "reviewer-a", WS_A); // re-enqueue after resolve
    expect(second.id).not.toBe(first.id); // a NEW pending item, not the stale resolved one
    expect(second.status).toBe("pending");
    // one pending + one resolved for the same span
    expect((await repo.listLabelingQueue({ status: "pending" }, WS_A)).items).toHaveLength(1);
    expect((await repo.listLabelingQueue({ status: "resolved" }, WS_A)).items).toHaveLength(1);
  });

  it("test_paged_list_is_bounded_and_workspace_scoped", async () => {
    // Seed 3 spans for ws-A + 1 for ws-B; a page of size 2 returns 2 items, all ws-A, total 3.
    for (const i of [1, 2, 3]) {
      await repo.save([span({ spanId: `s${i}`, traceId: `t${i}` })], WS_A);
      await repo.enqueueLabelingItem(`t${i}`, `s${i}`, "reviewer-a", WS_A);
    }
    await repo.save([span({ spanId: "sb", traceId: "tb" })], WS_B);
    await repo.enqueueLabelingItem("tb", "sb", "reviewer-b", WS_B);

    const page1 = await repo.listLabelingQueue({ page: 1, pageSize: 2 }, WS_A);
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(3); // ws-A total (ws-B's item excluded — workspace-scoped count)
    const page2 = await repo.listLabelingQueue({ page: 2, pageSize: 2 }, WS_A);
    expect(page2.items).toHaveLength(1);
    // no ws-B item ever appears in a ws-A page
    expect([...page1.items, ...page2.items].every((it) => it.traceId !== "tb")).toBe(true);
  });
});
