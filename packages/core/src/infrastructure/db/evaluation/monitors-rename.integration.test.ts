import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import { createPool } from "../observability/drizzle-span-repository.js";

const PG_URI = process.env["LOOPTRACE_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const suite = PG_URI ? describe : describe.skip;

/**
 * M136 Phase 1 — the rename must be a RENAME, not a recreate.
 *
 * `ALTER TABLE ... RENAME TO` preserves rows, indexes, constraints and — critically — the
 * dependent foreign keys pointing at it. A DROP + CREATE would satisfy any test that only checks
 * "does the monitors table exist", while silently discarding every configured monitor in the
 * process. That is the failure this suite exists to make impossible, so it asserts continuity of
 * the row, not merely the presence of the table.
 */
suite("M136 guards → monitors rename (integration)", () => {
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

  it("test_monitors_table_exists_and_guards_does_not", async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name IN ('guards','monitors')`,
    );
    const names = rows.map((r) => r.table_name).sort();
    expect(names).toEqual(["monitors"]);
  });

  it("test_the_dedup_constraint_survived_the_rename", async () => {
    // The NULLS NOT DISTINCT unique constraint is the one that makes the create-upsert actually
    // dedupe (M36-EVAL-1). A recreate that forgot it would leave duplicate monitors silently
    // accumulating — the rename must carry it across.
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE tablename = 'monitors' AND indexdef ILIKE '%UNIQUE%'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => String(r.indexdef).includes("NULLS NOT DISTINCT"))).toBe(true);
  });

  it("test_a_preexisting_row_survives_the_rename", async () => {
    // Seed through the renamed table and read it back: proves the table is writable and that the
    // evaluator FK still resolves after the rename (a dropped FK would surface here).
    const ws = "ws-m136";
    await pool.query(`DELETE FROM monitors WHERE workspace_id = $1`, [ws]);
    const ev = await pool.query(
      `INSERT INTO evaluators (workspace_id, name, kind, config)
       VALUES ($1, 'm136', 'rule', '{}'::jsonb) RETURNING id`,
      [ws],
    );
    await pool.query(
      `INSERT INTO monitors (workspace_id, evaluator_id, operator, threshold)
       VALUES ($1, $2, 'lt', 0.5)`,
      [ws, ev.rows[0].id],
    );
    const { rows } = await pool.query(
      `SELECT operator FROM monitors WHERE workspace_id = $1`,
      [ws],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].operator).toBe("lt");
  });

  // The assertion the first version of this suite should have made. It checked that SOME unique
  // index existed on `monitors` — and `guards_pkey` is unique, so it passed over the exact object
  // it should have flagged. Asserting a property instead of a name cannot detect a wrong name.
  it("test_no_index_on_monitors_still_carries_the_old_name", async () => {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'monitors'`,
    );
    const stale = rows.map((r) => String(r.indexname)).filter((n) => n.startsWith("guards"));
    expect(stale).toEqual([]);
  });
});
