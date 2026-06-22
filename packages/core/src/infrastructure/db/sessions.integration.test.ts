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
    endTimeUnixNano: "1700000000100000000", // 100ms
    ...overrides,
  };
}

suite("sessions grouping (integration, M13)", () => {
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
    await pool.query("TRUNCATE spans, traces, sessions, replay_sessions");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("test_get_session_detail_scoped_aggregates", async () => {
    // 3 traces in session S1: two ok (with tokens), one errored.
    await repo.save([span({ spanId: "a", traceId: "ta", sessionId: "S1", model: "gpt-4o", inputTokens: 100, outputTokens: 50 })]);
    await repo.save([span({ spanId: "b", traceId: "tb", sessionId: "S1", model: "gpt-4o", inputTokens: 10, outputTokens: 5 })]);
    await repo.save([span({ spanId: "c", traceId: "tc", sessionId: "S1", statusCode: "2" })]);
    const d = await repo.getSessionDetail("S1");
    expect(d).not.toBeNull();
    expect(d!.traceCount).toBe(3);
    expect(d!.totalTokens).toBe(165);
    expect(d!.costUsd).toBeGreaterThan(0);
    expect(d!.errorRate).toBe(round3(1 / 3));
    // all three spans are 100ms → p50 is exactly 100 (pins the nanos→ms scaling).
    expect(d!.latencyP50Ms).toBe(100);
    expect(d!.traces).toHaveLength(3);
  });

  it("test_session_cost_equals_sum_of_member_trace_costs", async () => {
    await repo.save([span({ spanId: "a", traceId: "ta", sessionId: "S1", model: "gpt-4o", inputTokens: 100, outputTokens: 50 })]);
    await repo.save([span({ spanId: "b", traceId: "tb", sessionId: "S1", model: "claude-3-5-sonnet", inputTokens: 1000, outputTokens: 500 })]);
    const d = await repo.getSessionDetail("S1");
    const ca = (await repo.getTraceCost("ta"))!.costUsd;
    const cb = (await repo.getTraceCost("tb"))!.costUsd;
    expect(d!.costUsd).toBe(round3(ca + cb)); // no drift (D2/risk #2)
  });

  it("test_get_session_detail_absent_returns_null", async () => {
    expect(await repo.getSessionDetail("does-not-exist")).toBeNull();
  });

  it("test_list_sessions_newest_first", async () => {
    await repo.save([span({ spanId: "a", traceId: "ta", sessionId: "S1" })]);
    await pool.query("UPDATE sessions SET last_seen_at = now() - interval '1 hour' WHERE session_id = 'S1'");
    await repo.save([span({ spanId: "b", traceId: "tb", sessionId: "S2" })]);
    const { sessions } = await repo.listSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(["S2", "S1"]); // newest first
  });

  it("test_list_sessions_deterministic_tiebreaker_on_equal_last_seen", async () => {
    // EC-7: two sessions with IDENTICAL last_seen_at order by session_id DESC.
    await pool.query(
      "INSERT INTO sessions (session_id, first_seen_at, last_seen_at) VALUES ('Sa', now(), '2026-06-22T12:00:00Z'), ('Sb', now(), '2026-06-22T12:00:00Z')",
    );
    const { sessions } = await repo.listSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(["Sb", "Sa"]);
  });

  it("test_ungrouped_trace_not_in_any_session", async () => {
    // a trace with NO session id (risk #1): never grouped, list stays empty.
    await repo.save([span({ spanId: "x", traceId: "tx" })]);
    const { sessions } = await repo.listSessions();
    expect(sessions).toEqual([]);
    // and it never resolves as a session detail.
    expect(await repo.getSessionDetail("tx")).toBeNull();
  });

  it("test_session_latency_excludes_null_bound_trace", async () => {
    // a 500ms member + a raw half-open trace (NULL end) directly inserted.
    await repo.save([span({ spanId: "n", traceId: "tn", sessionId: "S1", startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000500000000" })]);
    await pool.query(
      "INSERT INTO traces (trace_id, session_id, status_code, start_time_unix_nano, end_time_unix_nano, updated_at) VALUES ('topen','S1','ok','1700000000000000000', NULL, now())",
    );
    const d = await repo.getSessionDetail("S1");
    expect(d!.traceCount).toBe(2); // both counted
    // only the 500ms member enters the percentile; the NULL-bound is excluded (EC-1) → exactly 500.
    expect(d!.latencyP50Ms).toBe(500);
  });

  it("test_get_session_detail_zero_traces_is_safe", async () => {
    // Defensive (EC-2): a session row with no member traces → zeroed, not 404/NaN.
    await pool.query("INSERT INTO sessions (session_id, first_seen_at, last_seen_at) VALUES ('S0', now(), now())");
    const d = await repo.getSessionDetail("S0");
    expect(d!.traceCount).toBe(0);
    expect(d!.costUsd).toBe(0);
    expect(d!.errorRate).toBe(0);
    expect(d!.latencyP50Ms).toBe(0);
  });

  it("test_get_session_handles_encoded_id", async () => {
    await repo.save([span({ spanId: "a", traceId: "ta", sessionId: "conv/123" })]);
    const d = await repo.getSessionDetail("conv/123");
    expect(d?.sessionId).toBe("conv/123");
  });

  it("test_session_all_tokenless_traces_coalesce_to_zero", async () => {
    // EC-1: a session whose traces have no model/tokens → cost/tokens 0, not NULL.
    await repo.save([span({ spanId: "t", traceId: "tt", sessionId: "S1", toolName: "search" })]);
    const d = await repo.getSessionDetail("S1");
    expect(d!.costUsd).toBe(0);
    expect(d!.totalTokens).toBe(0);
  });
});

/** Local round3 mirror (kept tiny to avoid importing test-only helpers). */
function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
