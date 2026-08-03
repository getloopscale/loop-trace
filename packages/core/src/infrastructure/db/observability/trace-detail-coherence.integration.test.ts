/**
 * LT-034 — the three trace routes must agree with each other.
 *
 * Measured by the red team on app-dev (3 of 3, `git_sha=5efe6e8`): `GET /v1/traces` listed a trace
 * with name and metadata, `GET /v1/traces/<id>/cost` returned 200 with its cost and tokens, and
 * `GET /v1/traces/<id>` returned 404. Two routes of the same service asserted the trace exists and
 * one asserted it does not.
 *
 * Root cause, measured in the dev database: the three traces exist in `traces` with ZERO rows in
 * `spans`. `listTraces` and `getTraceCost` read the derived `traces` table; `getTraceTree` reads
 * `spans` and returns `null` on an empty result. Not a tenant filter — all three sit in workspace
 * `default`.
 *
 * WHY THIS TEST IS SHAPED THIS WAY: it takes the id FROM THE LISTING instead of from its own setup.
 * A test that seeded a trace and asserted "detail returns 200 for the id I inserted" would pass on
 * an implementation that stays incoherent with what the listing actually returns — the listing is
 * the contract the user sees, so it has to be the source of the id. The invariant is not "detail
 * answers 200"; it is "no id the listing hands out is unreachable".
 */
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import type pg from "pg";

import type { Span } from "../../../domain/observability/span.js";
import { createPool, DrizzleSpanRepository } from "./drizzle-span-repository.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const suite = PG_URI ? describe : describe.skip;

const WS = "ws-coherence";

function span(over: Partial<Span> & Pick<Span, "spanId" | "traceId">): Span {
  return {
    name: "op",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
    ...over,
  };
}

suite("LT-034 — the trace routes agree with each other (integration)", () => {
  let pool: pg.Pool;
  let db: NodePgDatabase;
  let repo: DrizzleSpanRepository;

  beforeAll(async () => {
    pool = createPool(PG_URI as string);
    db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    repo = new DrizzleSpanRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM spans WHERE workspace_id = ${WS}`);
    await db.execute(sql`DELETE FROM traces WHERE workspace_id = ${WS}`);
  });

  /** Reproduce the production shape: a row in `traces` whose spans are gone. */
  async function seedOrphanTrace(traceId: string, name: string): Promise<void> {
    await repo.save([span({ spanId: `${traceId}-s1`, traceId, name })], WS);
    // Retention, a manual cleanup, or a partial ingest leaves the derived row behind.
    await db.execute(sql`DELETE FROM spans WHERE workspace_id = ${WS} AND trace_id = ${traceId}`);
  }

  it("every trace the listing returns is reachable by its detail route", async () => {
    await repo.save([span({ spanId: "ok-1", traceId: "trace-with-spans", name: "healthy" })], WS);
    await seedOrphanTrace("trace-without-spans", "orphan");

    const listing = await repo.listTraces({}, WS);
    expect(listing.traces.length, "fixture must produce a listing to iterate").toBeGreaterThan(1);

    const unreachable: string[] = [];
    for (const t of listing.traces) {
      if ((await repo.getTraceTree(t.traceId, WS)) === null) unreachable.push(t.traceId);
    }

    expect(
      unreachable,
      `the listing handed out ${listing.traces.length} trace id(s); these are 404 on the detail ` +
        `route, so a user who clicks the row gets "not found" for something the product just showed them`,
    ).toEqual([]);
  });

  it("cost and detail agree on whether a trace exists", async () => {
    // The pair that made the report undeniable: same id, two routes, opposite answers.
    await seedOrphanTrace("trace-cost-vs-detail", "orphan");

    const cost = await repo.getTraceCost("trace-cost-vs-detail", WS);
    const detail = await repo.getTraceTree("trace-cost-vs-detail", WS);

    expect(
      cost === null,
      "cost and detail must not disagree about existence",
    ).toBe(detail === null);
  });

  it("a trace that genuinely does not exist is still 404 on all three", async () => {
    // Guard-the-guard: the fix must not turn every unknown id into a 200. Without this, making
    // the detail route always answer would satisfy the coherence tests above and break NOT_FOUND.
    expect(await repo.getTraceTree("no-such-trace-at-all", WS)).toBeNull();
    expect(await repo.getTraceCost("no-such-trace-at-all", WS)).toBeNull();
    const listing = await repo.listTraces({}, WS);
    expect(listing.traces.map((t) => t.traceId)).not.toContain("no-such-trace-at-all");
  });

  it("tenant isolation: another workspace reaches neither a trace WITH spans nor an orphan", async () => {
    // MEASURED 2026-08-01: the earlier version of this test seeded only an ORPHAN trace, so it
    // exercised the fallback path alone. Removing the workspace filter from the main path
    // (`getTraceTree` over `spans`) left all 18 tests GREEN — the leak that matters most was
    // invisible. The fixture has to carry BOTH shapes, because the two paths are scoped by
    // different queries and a fix to one says nothing about the other.
    //
    // Both ids below are REAL in workspace A. An id that exists nowhere would pass against an
    // implementation with no scoping at all, since a made-up id is absent from every tenant —
    // it proves the lock works by trying a key that opens no door.
    await repo.save([span({ spanId: "a-real-1", traceId: "trace-with-spans-of-a", name: "real" })], WS);
    await seedOrphanTrace("trace-orphan-of-a", "orphan-a");

    // Sanity: both ARE reachable from their own workspace, otherwise the assertions below would
    // pass for the wrong reason (nothing is reachable from anywhere).
    expect(await repo.getTraceTree("trace-with-spans-of-a", WS)).not.toBeNull();
    expect(await repo.getTraceTree("trace-orphan-of-a", WS)).not.toBeNull();

    for (const id of ["trace-with-spans-of-a", "trace-orphan-of-a"]) {
      expect(await repo.getTraceTree(id, "ws-someone-else"), `${id} leaked via detail`).toBeNull();
      expect(await repo.getTraceCost(id, "ws-someone-else"), `${id} leaked via cost`).toBeNull();
    }

    // …and the listing must not hand the ids out either.
    const foreign = await repo.listTraces({}, "ws-someone-else");
    expect(foreign.traces.map((x) => x.traceId)).not.toContain("trace-with-spans-of-a");
  });
});
