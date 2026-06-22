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

suite("listTraces filter/sort (integration, M9)", () => {
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

  async function seed(): Promise<void> {
    // error trace (any errored span → trace status 'error')
    await repo.save([span({ spanId: "e1", traceId: "t-err", statusCode: "2" })]);
    // ok trace
    await repo.save([span({ spanId: "o1", traceId: "t-ok", statusCode: "1" })]);
    // gpt-4o trace (ok)
    await repo.save([span({ spanId: "g1", traceId: "t-gpt", model: "gpt-4o" })]);
    // a slow + a fast trace for latency sorting
    await repo.save([
      span({
        spanId: "s1",
        traceId: "t-slow",
        startTimeUnixNano: "1700000000000000000",
        endTimeUnixNano: "1700000000900000000", // 900ms
      }),
    ]);
    await repo.save([
      span({
        spanId: "f1",
        traceId: "t-fast",
        startTimeUnixNano: "1700000000000000000",
        endTimeUnixNano: "1700000000010000000", // 10ms
      }),
    ]);
    // EC-1 / EC-2: a legacy raw row with NULL status + NULL times (edge).
    await pool.query(
      "INSERT INTO traces (trace_id, status_code, start_time_unix_nano, end_time_unix_nano, updated_at) VALUES ('t-null', NULL, NULL, NULL, now())",
    );
  }

  it("test_list_traces_filters_by_status_error", async () => {
    await seed();
    const { traces } = await repo.listTraces({ status: "error" });
    expect(traces.map((t) => t.traceId)).toEqual(["t-err"]);
  });

  it("test_list_traces_status_ok_includes_null_status", async () => {
    await seed();
    const { traces } = await repo.listTraces({ status: "ok" });
    const ids = traces.map((t) => t.traceId);
    expect(ids).toContain("t-null"); // EC-1: NULL status counts as ok
    expect(ids).toContain("t-ok");
    expect(ids).not.toContain("t-err");
  });

  it("test_list_traces_filters_by_model_via_span_subquery", async () => {
    await seed();
    const { traces } = await repo.listTraces({ model: "gpt-4o" });
    expect(traces.map((t) => t.traceId)).toEqual(["t-gpt"]);
  });

  it("test_list_traces_sorts_by_latency_with_null_and_skew", async () => {
    await seed();
    const { traces } = await repo.listTraces({ orderBy: "latency", dir: "desc" });
    const ids = traces.map((t) => t.traceId);
    // slow (900ms) before fast (10ms); the NULL-times row sorts last (NULLS LAST).
    expect(ids.indexOf("t-slow")).toBeLessThan(ids.indexOf("t-fast"));
    expect(ids[ids.length - 1]).toBe("t-null");
  });

  it("test_list_traces_filters_by_time_window", async () => {
    await seed();
    // Push t-ok far into the past, then ask for only the last hour.
    await pool.query(
      "UPDATE traces SET updated_at = now() - interval '10 days' WHERE trace_id = 't-ok'",
    );
    const from = new Date(Date.now() - 3600_000).toISOString();
    const { traces } = await repo.listTraces({ from });
    expect(traces.map((t) => t.traceId)).not.toContain("t-ok");
    expect(traces.map((t) => t.traceId)).toContain("t-err");
  });

  it("test_list_traces_empty_result_for_nonmatching_filter", async () => {
    await seed();
    const { traces } = await repo.listTraces({ model: "no-such-model" });
    expect(traces).toEqual([]);
  });

  it("test_list_traces_default_is_newest_first_unchanged", async () => {
    await repo.save([span({ spanId: "a1", traceId: "t-1" })]);
    await repo.save([span({ spanId: "b1", traceId: "t-2" })]);
    const { traces } = await repo.listTraces();
    // newest updated_at first; t-2 was saved last.
    expect(traces[0]?.traceId).toBe("t-2");
    expect(traces).toHaveLength(2);
  });
});
