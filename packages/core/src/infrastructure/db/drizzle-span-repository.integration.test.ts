import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { Span } from "../../domain/span.js";
import { createPool, DrizzleSpanRepository } from "./drizzle-span-repository.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("./migrations", import.meta.url));

// EC-3/EC-6: apply the COMMITTED migrations (real release artifact), not db:push.
// Env-gated: when THEOLENS_PG_URI is unset, the whole suite skips cleanly.
const suite = PG_URI ? describe : describe.skip;

suite("DrizzleSpanRepository (integration)", () => {
  let pool: pg.Pool;
  let db: NodePgDatabase;
  let repo: DrizzleSpanRepository;

  const span: Span = {
    spanId: "int-a1",
    traceId: "int-t1",
    name: "op",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
    attributes: { "service.name": "probe", count: 3 },
  };

  beforeAll(async () => {
    pool = createPool(PG_URI as string);
    db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    repo = new DrizzleSpanRepository(db);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE spans");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("repo_saves_and_reads_back_a_span", async () => {
    await repo.save([span]);
    const got = await repo.getBySpanId("int-a1");
    expect(got).toEqual(span);
  });

  it("repo_returns_null_for_unknown_span", async () => {
    expect(await repo.getBySpanId("nope")).toBeNull();
  });

  it("repo_save_is_idempotent_on_duplicate_spanId", async () => {
    await repo.save([span]);
    await repo.save([{ ...span, name: "changed" }]);
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM spans WHERE span_id = $1",
      ["int-a1"],
    );
    expect(rows[0]?.n).toBe("1");
  });

  it("repo_save_dedupes_intrabatch_duplicate_spanId", async () => {
    // EC-1: same spanId twice in ONE save call must not crash and yields one row.
    await repo.save([span, { ...span, name: "dup" }]);
    const got = await repo.getBySpanId("int-a1");
    expect(got).not.toBeNull();
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM spans WHERE span_id = $1",
      ["int-a1"],
    );
    expect(rows[0]?.n).toBe("1");
  });

  it("repo_save_empty_array_is_noop", async () => {
    await expect(repo.save([])).resolves.toBeUndefined();
  });
});
