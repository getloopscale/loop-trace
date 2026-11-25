import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@looptrace/core/infra";
import type pg from "pg";

import { bootstrap } from "./index.js";

/**
 * Integration test for migrate-on-boot (T1.3, D2): against a *pristine* Postgres
 * (no migrations applied), `bootstrap` must apply the committed migrations and
 * the resulting app must round-trip a span — proving a clean `docker compose up`
 * is ready to ingest with NO external migration step. Gated by LOOPTRACE_PG_URI.
 */
const PG_URI = process.env["LOOPTRACE_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

suite("composition root migrate-on-boot (integration)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createPool(PG_URI as string);
    // Make the database pristine: drop the drizzle journal + EVERY table in `public`
    // so `bootstrap` must recreate them from the committed migrations. Dropping every
    // table dynamically (not a hardcoded list) is future-proof: a table added by a new
    // migration (labeling_queue_items, experiment_runs, …) that a stale list omits would
    // survive the reset and make migrate-from-scratch fail with "relation already exists"
    // — which also corrupts the shared DB for every other integration file in the suite.
    await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await pool.query(`DO $$ DECLARE r RECORD; BEGIN
      FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;`);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("test_boot_migrates_then_ingest_roundtrips_on_clean_db", async () => {
    const { app, pool: bootPool } = await bootstrap(PG_URI as string);
    try {
      const envelope = {
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    spanId: "boot-span-1",
                    traceId: "boot-trace-1",
                    name: "checkout",
                    startTimeUnixNano: "1700000000000000000",
                    endTimeUnixNano: "1700000000250000000",
                  },
                ],
              },
            ],
          },
        ],
      };
      const post = await app.request("/v1/traces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(envelope),
      });
      expect(post.status).toBe(200);

      const get = await app.request("/v1/spans/boot-span-1");
      expect(get.status).toBe(200);
      expect((await get.json()).spanId).toBe("boot-span-1");
    } finally {
      await bootPool.end();
    }
  });
});
