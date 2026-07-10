import { afterAll, describe, expect, it } from "vitest";
import type pg from "pg";

import { createPool } from "./drizzle-span-repository.js";
import { DEFAULT_POOL_CONFIG } from "../../domain/evaluator-config.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

suite("M94 pool resilience config (integration)", () => {
  const pools: pg.Pool[] = [];
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
  });

  it("statement_timeout aborts a query that runs longer than the bound", async () => {
    // A 200ms statement_timeout against a 2s sleep → Postgres cancels the query, freeing the
    // connection (vs an unbounded hang that would pin the pool). Proves the pool enforces the bound.
    const pool = createPool(PG_URI as string, { ...DEFAULT_POOL_CONFIG, statement_timeout: 200, query_timeout: 5_000 });
    pools.push(pool);
    await expect(pool.query("SELECT pg_sleep(2)")).rejects.toThrow(/statement timeout|canceling statement/i);
  });

  it("a fast query under the bound still succeeds", async () => {
    const pool = createPool(PG_URI as string, { ...DEFAULT_POOL_CONFIG, statement_timeout: 5_000 });
    pools.push(pool);
    const res = await pool.query("SELECT 1 AS ok");
    expect(res.rows[0]).toEqual({ ok: 1 });
  });

  it("the pool carries the configured max (bounds DB connections under burst)", () => {
    const pool = createPool(PG_URI as string, { ...DEFAULT_POOL_CONFIG, max: 7 });
    pools.push(pool);
    expect(pool.options.max).toBe(7);
  });

  it("attaches an idle-error handler so a DB outage does not crash the process (M94 live-smoke fix)", () => {
    // Without a pool `error` listener, node-pg re-throws an idle-client error as uncaught → crash.
    // The M94 live-smoke caught exactly this (DB stop crashed the node); the handler prevents it.
    const pool = createPool(PG_URI as string);
    pools.push(pool);
    expect(pool.listenerCount("error")).toBeGreaterThanOrEqual(1);
  });
});
