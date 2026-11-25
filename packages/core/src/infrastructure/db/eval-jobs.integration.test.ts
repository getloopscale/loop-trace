import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import { createPool } from "./observability/drizzle-span-repository.js";

const PG_URI = process.env["LOOPTRACE_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("./migrations", import.meta.url));
const suite = PG_URI ? describe : describe.skip;

const EV_A = "11111111-1111-1111-1111-111111111111";
const EV_B = "22222222-2222-2222-2222-222222222222";

/**
 * M134 T1.1 — the `eval_jobs` dedup invariant.
 *
 * ADR D4 makes dedup a DB constraint rather than application logic. The
 * blueprint recorded why (AP-1): the reference deduped with a read-then-write
 * and no unique index, which races under exactly the traffic that makes dedup
 * matter — a trace is upserted many times as it streams, and ingestion retries
 * at-least-once. looptrace already learned this once in M36, where the `guards`
 * table needed NULLS NOT DISTINCT before its dedup actually fired.
 *
 * These tests exercise the constraint at the SQL level, which is where the
 * guarantee lives. A unit test against a fake would prove nothing here.
 */
suite("eval_jobs dedup invariant (integration, M134 T1.1)", () => {
  let pool: pg.Pool;
  let db: NodePgDatabase;

  beforeAll(async () => {
    pool = createPool(PG_URI as string);
    db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS });
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE eval_jobs");
  });

  afterAll(async () => {
    await pool.end();
  });

  const enqueue = (traceId: string, evaluatorId = EV_A, workspaceId = "default") =>
    pool.query(
      `INSERT INTO eval_jobs (workspace_id, evaluator_id, trace_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, evaluator_id, trace_id) DO NOTHING`,
      [workspaceId, evaluatorId, traceId],
    );

  it("test_enqueue_twice_yields_one_row", async () => {
    await enqueue("t-1");
    await enqueue("t-1");

    const { rows } = await pool.query("SELECT count(*)::int n FROM eval_jobs");
    expect(rows[0].n).toBe(1);
  });

  it("test_concurrent_enqueue_same_tuple_yields_one_row", async () => {
    // The assertion a single-threaded insert test cannot make. Two enqueues of
    // the same tuple issued in parallel: exactly one row survives and NEITHER
    // call raises — the loser is absorbed by ON CONFLICT, not by a try/catch.
    const results = await Promise.allSettled([
      enqueue("t-race"),
      enqueue("t-race"),
      enqueue("t-race"),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const { rows } = await pool.query("SELECT count(*)::int n FROM eval_jobs");
    expect(rows[0].n).toBe(1);
  });

  it("test_dedup_does_not_collapse_distinct_evaluators", async () => {
    // The grain is (workspace, evaluator, trace) — two evaluators must BOTH
    // score the same trace. A too-coarse key would silently drop one.
    await enqueue("t-2", EV_A);
    await enqueue("t-2", EV_B);

    const { rows } = await pool.query("SELECT count(*)::int n FROM eval_jobs");
    expect(rows[0].n).toBe(2);
  });

  it("test_dedup_is_workspace_scoped", async () => {
    // EC-5 adjacent: the same trace_id in two workspaces is two distinct rows.
    // A workspace-blind key would let tenant A's enqueue suppress tenant B's.
    await enqueue("t-shared", EV_A, "ws-a");
    await enqueue("t-shared", EV_A, "ws-b");

    const { rows } = await pool.query(
      "SELECT workspace_id FROM eval_jobs ORDER BY workspace_id",
    );
    expect(rows.map((r) => r.workspace_id)).toEqual(["ws-a", "ws-b"]);
  });

  it("test_reenqueue_while_unclaimed_pushes_run_after", async () => {
    // EC-6 — the half of the mitigation the plan originally dropped. A trace
    // arriving across many OTLP batches must RE-ARM its job while it is still
    // queued, otherwise it is scored once on whatever spans existed at the
    // first sweep and every later batch is silently never evaluated.
    await enqueue("t-stream");
    const first = await pool.query(
      "SELECT run_after FROM eval_jobs WHERE trace_id = 't-stream'",
    );

    await pool.query(
      `INSERT INTO eval_jobs (workspace_id, evaluator_id, trace_id, run_after)
       VALUES ('default', $1, 't-stream', now() + interval '5 seconds')
       ON CONFLICT (workspace_id, evaluator_id, trace_id)
       DO UPDATE SET run_after = EXCLUDED.run_after
       WHERE eval_jobs.claimed_at IS NULL`,
      [EV_A],
    );

    const second = await pool.query(
      "SELECT run_after FROM eval_jobs WHERE trace_id = 't-stream'",
    );
    expect(new Date(second.rows[0].run_after).getTime()).toBeGreaterThan(
      new Date(first.rows[0].run_after).getTime(),
    );
    const { rows } = await pool.query("SELECT count(*)::int n FROM eval_jobs");
    expect(rows[0].n).toBe(1);
  });

  it("test_reenqueue_does_not_rearm_an_already_claimed_job", async () => {
    // The other side of EC-6: once a worker holds the row, re-ingest must NOT
    // push run_after out from under it — that would let a busy stream starve
    // its own evaluation indefinitely.
    await enqueue("t-claimed");
    await pool.query(
      `UPDATE eval_jobs SET claimed_at = now(), claimed_by = 'w1', status = 'running'
       WHERE trace_id = 't-claimed'`,
    );
    const before = await pool.query(
      "SELECT run_after FROM eval_jobs WHERE trace_id = 't-claimed'",
    );

    await pool.query(
      `INSERT INTO eval_jobs (workspace_id, evaluator_id, trace_id, run_after)
       VALUES ('default', $1, 't-claimed', now() + interval '5 seconds')
       ON CONFLICT (workspace_id, evaluator_id, trace_id)
       DO UPDATE SET run_after = EXCLUDED.run_after
       WHERE eval_jobs.claimed_at IS NULL`,
      [EV_A],
    );

    const after = await pool.query(
      "SELECT run_after FROM eval_jobs WHERE trace_id = 't-claimed'",
    );
    expect(new Date(after.rows[0].run_after).getTime()).toBe(
      new Date(before.rows[0].run_after).getTime(),
    );
  });
});
