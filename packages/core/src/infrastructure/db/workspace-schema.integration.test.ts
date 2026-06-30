import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import type pg from "pg";

import { createPool } from "./drizzle-span-repository.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("./migrations", import.meta.url));
const suite = PG_URI ? describe : describe.skip;

/** The 9 data tables that MUST carry workspace_id (M22). */
const DATA_TABLES = [
  "spans",
  "traces",
  "sessions",
  "replay_sessions",
  "trace_tags",
  "span_evaluations",
  "annotations",
  "datasets",
  "dataset_items",
] as const;

suite("M22 workspace schema (integration)", () => {
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

  it("test_integration_workspace_id_on_all_data_tables_default_default", async () => {
    for (const table of DATA_TABLES) {
      const { rows } = await pool.query<{ column_default: string | null; is_nullable: string }>(
        `SELECT column_default, is_nullable FROM information_schema.columns
         WHERE table_name = $1 AND column_name = 'workspace_id'`,
        [table],
      );
      expect(rows, `${table} must have workspace_id`).toHaveLength(1);
      expect(rows[0]?.is_nullable, `${table}.workspace_id must be NOT NULL`).toBe("NO");
      expect(rows[0]?.column_default ?? "").toContain("default"); // DEFAULT 'default'
    }
  });

  it("test_integration_auth_tables_present_with_default_seed", async () => {
    for (const t of ["theo_api_keys", "workspaces", "workspace_users"]) {
      const { rows } = await pool.query(
        `SELECT 1 FROM information_schema.tables WHERE table_name = $1`,
        [t],
      );
      expect(rows, `${t} must exist`).toHaveLength(1);
    }
    const ws = await pool.query(`SELECT id FROM workspaces WHERE id = 'default'`);
    expect(ws.rows, "default workspace seeded").toHaveLength(1);
    const owner = await pool.query(
      `SELECT role FROM workspace_users WHERE workspace_id = 'default' AND user_id = 'default-owner'`,
    );
    expect((owner.rows[0] as { role: string } | undefined)?.role).toBe("owner");
  });

  it("test_integration_dataset_name_unique_is_workspace_leading", async () => {
    // The same dataset name in two workspaces must NOT collide (theo-data EC-12).
    await db.execute(sql`DELETE FROM datasets WHERE name = 'dup-probe'`);
    await db.execute(
      sql`INSERT INTO datasets (workspace_id, name) VALUES ('ws-a', 'dup-probe')`,
    );
    await expect(
      db.execute(
        sql`INSERT INTO datasets (workspace_id, name) VALUES ('ws-b', 'dup-probe')`,
      ),
    ).resolves.toBeDefined(); // different workspace → no collision
    // same workspace + name → collision (the unique still guards within a workspace)
    await expect(
      db.execute(
        sql`INSERT INTO datasets (workspace_id, name) VALUES ('ws-a', 'dup-probe')`,
      ),
    ).rejects.toThrow();
    await db.execute(sql`DELETE FROM datasets WHERE name = 'dup-probe'`);
  });
});
