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

suite("aggregateObservability (integration, M11)", () => {
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

  it("test_aggregate_observability_traffic_error_rate", async () => {
    await repo.save([span({ spanId: "e", traceId: "t-err", statusCode: "2" })]);
    await repo.save([span({ spanId: "a", traceId: "t-a", statusCode: "1" })]);
    await repo.save([span({ spanId: "b", traceId: "t-b", statusCode: "1" })]);
    await repo.save([span({ spanId: "c", traceId: "t-c", statusCode: "1" })]);
    const obs = await repo.aggregateObservability("24h");
    const totalTraces = obs.traffic.reduce((s, b) => s + b.traceCount, 0);
    const totalErrors = obs.traffic.reduce((s, b) => s + b.errorCount, 0);
    expect(totalTraces).toBe(4);
    expect(totalErrors).toBe(1);
    // errorRate per bucket is in [0,1]; with all 4 in one bucket → 0.25
    expect(obs.traffic.some((b) => b.errorRate === 0.25)).toBe(true);
  });

  it("test_aggregate_observability_latency_percentiles_clamp_skew", async () => {
    await repo.save([
      span({ spanId: "f", traceId: "t-f", startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000010000000" }), // 10ms
    ]);
    await repo.save([
      span({ spanId: "s", traceId: "t-s", startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000900000000" }), // 900ms
    ]);
    await repo.save([
      span({ spanId: "k", traceId: "t-skew", startTimeUnixNano: "1700000000900000000", endTimeUnixNano: "1700000000000000000" }), // end<start
    ]);
    const obs = await repo.aggregateObservability("24h");
    // percentiles exist + are non-negative (skew clamped to 0, never negative)
    expect(obs.latency.length).toBeGreaterThan(0);
    for (const b of obs.latency) {
      expect(b.p50Ms).toBeGreaterThanOrEqual(0);
      expect(b.p99Ms).toBeGreaterThanOrEqual(b.p50Ms);
    }
  });

  it("test_aggregate_observability_latency_excludes_null_bound_trace", async () => {
    // a normal 500ms trace + a raw half-open trace (NULL end) inserted directly.
    await repo.save([
      span({ spanId: "n", traceId: "t-n", startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000500000000" }),
    ]);
    await pool.query(
      "INSERT INTO traces (trace_id, status_code, start_time_unix_nano, end_time_unix_nano, updated_at) VALUES ('t-open','ok','1700000000000000000', NULL, now())",
    );
    const obs = await repo.aggregateObservability("24h");
    // The half-open trace is excluded (EC-1): p50 reflects the 500ms trace, not a 0.
    const p50s = obs.latency.map((b) => b.p50Ms);
    expect(p50s.some((p) => p >= 400)).toBe(true); // ~500ms, not dragged to 0
  });

  it("test_aggregate_observability_tokens_and_cost_by_model", async () => {
    await repo.save([
      span({ spanId: "m1", traceId: "t-m1", model: "gpt-4o", inputTokens: 100, outputTokens: 50 }),
    ]);
    await repo.save([
      span({ spanId: "m2", traceId: "t-m2", model: "claude-3-5-sonnet", inputTokens: 10, outputTokens: 5 }),
    ]);
    // a tool span with NO model must be excluded (EC-4)
    await repo.save([
      span({ spanId: "tool", traceId: "t-tool", toolName: "search", inputTokens: 0, outputTokens: 0 }),
    ]);
    const obs = await repo.aggregateObservability("24h");
    const models = obs.tokensByModel.map((m) => m.model);
    expect(models).toContain("gpt-4o");
    expect(models).not.toContain(null);
    const gpt = obs.tokensByModel.find((m) => m.model === "gpt-4o")!;
    expect(gpt.totalTokens).toBe(150);
    expect(gpt.costUsd).toBeGreaterThan(0);
  });

  it("test_aggregate_observability_tokens_by_model_excludes_null_model", async () => {
    await repo.save([span({ spanId: "tool", traceId: "t-only-tool", toolName: "search" })]);
    const obs = await repo.aggregateObservability("24h");
    expect(obs.tokensByModel).toEqual([]); // no model-bearing spans
  });

  it("test_aggregate_observability_empty_range_returns_empty_series", async () => {
    const obs = await repo.aggregateObservability("1h");
    expect(obs.traffic).toEqual([]);
    expect(obs.latency).toEqual([]);
    expect(obs.tokensByModel).toEqual([]);
    expect(obs.range).toBe("1h");
  });
});
