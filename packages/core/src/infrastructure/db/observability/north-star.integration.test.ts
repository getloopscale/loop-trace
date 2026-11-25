import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { Span } from "../../../domain/observability/span.js";
import { createPool, DrizzleSpanRepository } from "./drizzle-span-repository.js";

const PG_URI = process.env["LOOPTRACE_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const suite = PG_URI ? describe : describe.skip;

function span(overrides: Partial<Span> & Pick<Span, "spanId" | "traceId">): Span {
  return {
    name: "op",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
    ...overrides,
  };
}

suite("North-star metrics (integration)", () => {
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
    // EC-2: include replay_sessions so cross-test rows never pollute the counts.
    await pool.query("TRUNCATE spans, traces, sessions, replay_sessions");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("test_replay_sessions_table_persists_a_row", async () => {
    await repo.recordReplaySession("trace-xyz");
    const res = await pool.query(
      "SELECT trace_id FROM replay_sessions WHERE trace_id = 'trace-xyz'",
    );
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].trace_id).toBe("trace-xyz");
  });

  it("test_record_replay_session_inserts_row", async () => {
    await repo.recordReplaySession("t1");
    await repo.recordReplaySession("t2");
    const res = await pool.query("SELECT count(*)::int AS n FROM replay_sessions");
    expect(res.rows[0].n).toBe(2);
  });

  it("test_aggregate_north_star_counts_traces_per_day_and_sessions_per_week", async () => {
    // 2 distinct traces ingested today; trace t1 has 2 spans (must count ONCE).
    await repo.save([
      span({ spanId: "a1", traceId: "t1" }),
      span({ spanId: "a2", traceId: "t1" }),
      span({ spanId: "b1", traceId: "t2" }),
    ]);
    await repo.recordReplaySession("t1");

    const ns = await repo.aggregateNorthStar();

    // traces/day: t1 + t2 = 2 distinct today (a1+a2 collapse to one trace).
    const totalTracesToday = ns.tracesPerDay.reduce((s, b) => s + b.count, 0);
    expect(totalTracesToday).toBe(2);

    // EC-4: assert the session is counted within the recent window (sum over
    // weeks), not a hard-coded week-label string (date_trunc week is TZ-sensitive).
    const totalSessions = ns.replaySessionsPerWeek.reduce((s, b) => s + b.count, 0);
    expect(totalSessions).toBe(1);
  });

  it("test_aggregate_north_star_empty_when_no_data", async () => {
    const ns = await repo.aggregateNorthStar();
    expect(ns.tracesPerDay).toEqual([]);
    expect(ns.replaySessionsPerWeek).toEqual([]);
  });
});
