import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { Span } from "../../domain/span.js";
import { createPool, DrizzleSpanRepository } from "./drizzle-span-repository.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("./migrations", import.meta.url));
const suite = PG_URI ? describe : describe.skip;

function span(overrides: Partial<Span> & Pick<Span, "spanId" | "traceId">): Span {
  return {
    name: "op",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
    ...overrides,
  };
}

const THIRTY_DAYS_AGO = (): Date => new Date(Date.now() - 30 * 86_400_000);

suite("prune retention cascade (integration, M23 T1.1)", () => {
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
    await pool.query("TRUNCATE spans, traces, sessions, replay_sessions, trace_tags");
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Backdate a trace's updated_at AFTER all saves (EC-2: save() resets it to now()). */
  async function backdate(traceId: string, days: number): Promise<void> {
    await pool.query(
      `UPDATE traces SET updated_at = now() - ($1 || ' days')::interval WHERE trace_id = $2`,
      [String(days), traceId],
    );
  }

  it("prune_deletes_old_traces_and_cascades", async () => {
    // OLD trace (session S-old) with a tag + a replay row; FRESH trace (session S-fresh).
    await repo.save([span({ spanId: "o1", traceId: "t-old", sessionId: "S-old" })]);
    await repo.addTag("t-old", "keep");
    await repo.recordReplaySession("t-old");
    await repo.save([span({ spanId: "f1", traceId: "t-fresh", sessionId: "S-fresh" })]);
    // EC-2: backdate AFTER the last save so the recompute can't reset it.
    await backdate("t-old", 100);

    const before = await pool.query("SELECT count(*)::int n FROM traces");
    expect(before.rows[0].n).toBe(2);

    const stats = await repo.prune(THIRTY_DAYS_AGO());

    expect(stats.tracesDeleted).toBe(1);
    expect(stats.spansDeleted).toBe(1);
    expect(stats.tagsDeleted).toBe(1);
    expect(stats.replaySessionsDeleted).toBe(1);
    expect(stats.sessionsDeleted).toBe(1); // S-old orphaned

    // the old trace + its rows are gone; the fresh trace + its session survive
    const traces = await pool.query("SELECT trace_id FROM traces ORDER BY trace_id");
    expect(traces.rows.map((r) => r.trace_id)).toEqual(["t-fresh"]);
    const spans = await pool.query("SELECT count(*)::int n FROM spans");
    expect(spans.rows[0].n).toBe(1);
    const sessions = await pool.query("SELECT session_id FROM sessions ORDER BY session_id");
    expect(sessions.rows.map((r) => r.session_id)).toEqual(["S-fresh"]);
    const tags = await pool.query("SELECT count(*)::int n FROM trace_tags");
    expect(tags.rows[0].n).toBe(0);
    const replay = await pool.query("SELECT count(*)::int n FROM replay_sessions");
    expect(replay.rows[0].n).toBe(0);
  });

  it("prune_is_noop_when_nothing_older", async () => {
    await repo.save([span({ spanId: "a", traceId: "t-fresh" })]);
    const stats = await repo.prune(THIRTY_DAYS_AGO());
    expect(stats).toMatchObject({
      tracesDeleted: 0,
      spansDeleted: 0,
      sessionsDeleted: 0,
    });
    const n = await pool.query("SELECT count(*)::int n FROM traces");
    expect(n.rows[0].n).toBe(1);
  });

  it("prune_keeps_session_with_a_surviving_trace", async () => {
    // session S has one OLD trace + one FRESH trace → S must survive.
    await repo.save([span({ spanId: "o", traceId: "t-old", sessionId: "S" })]);
    await repo.save([span({ spanId: "f", traceId: "t-fresh", sessionId: "S" })]);
    await backdate("t-old", 100);

    const stats = await repo.prune(THIRTY_DAYS_AGO());
    expect(stats.tracesDeleted).toBe(1);
    expect(stats.sessionsDeleted).toBe(0); // S still has t-fresh

    const sessions = await pool.query("SELECT session_id FROM sessions");
    expect(sessions.rows.map((r) => r.session_id)).toEqual(["S"]);
  });

  it("prune_orphan_session_cleanup_survives_null_session_traces", async () => {
    // EC-1: a NULL-session trace present in `traces` must NOT silence the orphan
    // cleanup (NOT IN with a NULL → UNKNOWN for all rows). The real orphan is deleted.
    await repo.save([span({ spanId: "n", traceId: "t-null" })]); // no sessionId → NULL
    await repo.save([span({ spanId: "o", traceId: "t-old", sessionId: "S-orphan" })]);
    await backdate("t-old", 100);

    const stats = await repo.prune(THIRTY_DAYS_AGO());
    expect(stats.tracesDeleted).toBe(1); // only t-old
    expect(stats.sessionsDeleted).toBe(1); // S-orphan deleted despite the NULL-session trace

    const sessions = await pool.query("SELECT count(*)::int n FROM sessions");
    expect(sessions.rows[0].n).toBe(0);
    const traces = await pool.query("SELECT trace_id FROM traces");
    expect(traces.rows.map((r) => r.trace_id)).toEqual(["t-null"]); // NULL-session trace kept (fresh)
  });
});
