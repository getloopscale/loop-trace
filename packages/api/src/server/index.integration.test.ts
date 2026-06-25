import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@usetheo/lens-core";
import type pg from "pg";

import { bootstrap } from "./index.js";

/**
 * Integration test for migrate-on-boot (T1.3, D2): against a *pristine* Postgres
 * (no migrations applied), `bootstrap` must apply the committed migrations and
 * the resulting app must round-trip a span — proving a clean `docker compose up`
 * is ready to ingest with NO external migration step. Gated by THEOLENS_PG_URI.
 */
const PG_URI = process.env["THEOLENS_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

suite("composition root migrate-on-boot (integration)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createPool(PG_URI as string);
    // Make the database pristine: drop the drizzle journal + ALL domain tables
    // so `bootstrap` must recreate them from the committed migrations. The list
    // MUST include every table any migration creates — a missing one (e.g. M14's
    // trace_tags) survives the reset and makes migrate-from-scratch fail with
    // "relation already exists".
    await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
    await pool.query(
      "DROP TABLE IF EXISTS spans, traces, sessions, replay_sessions, trace_tags, span_evaluations CASCADE",
    );
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
