import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import { createPool } from "./observability/drizzle-span-repository.js";

const PG_URI = process.env["LOOPTRACE_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("./migrations", import.meta.url));
const suite = PG_URI ? describe : describe.skip;

/**
 * M95 — proves the composite/covering indexes (migration 0025) exist AND are chosen by the planner
 * for the hot-path access patterns. The deterministic half (index EXISTS) never flakes; the EXPLAIN
 * half is asserted only for the STABLE point-lookup (the eval-count subquery — a selective
 * `WHERE ws AND trace_id` always picks the covering index), avoiding planner-selectivity flakiness.
 */
suite("M95 query-layer index usage (integration)", () => {
  let pool: pg.Pool;
  let db: NodePgDatabase;

  beforeAll(async () => {
    pool = createPool(PG_URI as string);
    db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS });
  });
  afterAll(async () => {
    await pool.end();
  });

  it("the four M95 composite indexes exist after migration (deterministic)", async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE indexname = ANY($1)`,
      [[
        "traces_workspace_updated_idx",
        "spans_workspace_ingested_idx",
        "sessions_workspace_last_seen_idx",
        "span_evaluations_workspace_trace_idx",
      ]],
    );
    expect(new Set(rows.map((r) => r.indexname))).toEqual(
      new Set([
        "traces_workspace_updated_idx",
        "spans_workspace_ingested_idx",
        "sessions_workspace_last_seen_idx",
        "span_evaluations_workspace_trace_idx",
      ]),
    );
  });

  it("the listTraces eval-count subquery is served INDEX-ONLY by the (workspace_id, trace_id) index (de-N+1)", async () => {
    // Seed enough rows that the planner would seq-scan without the covering index; a selective point
    // lookup (`ws AND trace_id`) is STABLE → always an index-only scan, so this EXPLAIN never flakes.
    await pool.query("TRUNCATE span_evaluations");
    await pool.query(
      `INSERT INTO span_evaluations (workspace_id, span_id, trace_id, name)
       SELECT 'ws-idx', 's'||g, 't'||(g % 5000), 'q' FROM generate_series(1, 20000) g`,
    );
    await pool.query("ANALYZE span_evaluations");
    const { rows } = await pool.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (COSTS OFF) SELECT count(*) FROM span_evaluations se WHERE se.trace_id = 't42' AND se.workspace_id = 'ws-idx'`,
    );
    const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(plan).toMatch(/Index Only Scan using span_evaluations_workspace_trace_idx/);
    expect(plan).not.toMatch(/Seq Scan on span_evaluations/);
  });
});
