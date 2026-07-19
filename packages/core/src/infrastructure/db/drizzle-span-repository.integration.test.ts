import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { Span } from "../../domain/observability/span.js";
import { computeToolStats } from "../../domain/observability/tool-stats.js";
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

suite("DrizzleSpanRepository (integration)", () => {
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

  it("repo_saves_and_reads_back_a_span", async () => {
    const s = span({ spanId: "a1", traceId: "t1", attributes: { k: "v" } });
    await repo.save([s]);
    expect(await repo.getBySpanId("a1")).toEqual(s);
  });

  it("repo_returns_null_for_unknown_span", async () => {
    expect(await repo.getBySpanId("nope")).toBeNull();
  });

  it("repo_save_dedupes_intrabatch_duplicate_spanId", async () => {
    await repo.save([
      span({ spanId: "a1", traceId: "t1" }),
      span({ spanId: "a1", traceId: "t1", name: "dup" }),
    ]);
    const { rows } = await pool.query<{ n: string }>(
      "SELECT count(*)::text n FROM spans WHERE span_id='a1'",
    );
    expect(rows[0]?.n).toBe("1");
  });

  it("repo_save_does_not_create_a_phantom_trace_row_for_a_reused_spanId_under_a_new_traceId", async () => {
    // Regression for #52: a span_id is globally unique per workspace and deduped on
    // (workspace_id, span_id). Re-ingesting the SAME span_id under a NEW trace_id must NOT
    // create a `traces` rollup row for that new trace (the recompute runs over zero matching
    // spans, so no phantom row should be written).
    await repo.save([span({ spanId: "dup", traceId: "t1" })]);
    await repo.save([span({ spanId: "dup", traceId: "t2" })]);
    const t2 = await pool.query<{ n: string }>(
      "SELECT count(*)::text n FROM traces WHERE trace_id='t2'",
    );
    expect(t2.rows[0]?.n).toBe("0"); // no phantom rollup
    const t1 = await pool.query<{ n: string }>(
      "SELECT count(*)::text n FROM traces WHERE trace_id='t1'",
    );
    expect(t1.rows[0]?.n).toBe("1"); // the real trace is unaffected
  });

  it("repo_persists_enriched_span_columns", async () => {
    const s = span({
      spanId: "a1",
      traceId: "t1",
      kind: "3",
      statusMessage: "ok",
      model: "gpt-4o",
      provider: "openai",
      inputTokens: 10,
      outputTokens: 5,
    });
    await repo.save([s]);
    expect(await repo.getBySpanId("a1")).toEqual(s);
  });

  it("repo_upserts_trace_aggregate_tokens_and_timespan", async () => {
    await repo.save([
      span({ spanId: "a1", traceId: "t1", inputTokens: 10, outputTokens: 4, startTimeUnixNano: "100", endTimeUnixNano: "200" }),
      span({ spanId: "a2", traceId: "t1", inputTokens: 1, outputTokens: 1, startTimeUnixNano: "50", endTimeUnixNano: "300" }),
    ]);
    const { rows } = await pool.query<{
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      start_time_unix_nano: string;
      end_time_unix_nano: string;
    }>("SELECT input_tokens, output_tokens, total_tokens, start_time_unix_nano, end_time_unix_nano FROM traces WHERE trace_id='t1'");
    expect(rows[0]?.input_tokens).toBe(11);
    expect(rows[0]?.output_tokens).toBe(5);
    expect(rows[0]?.total_tokens).toBe(16);
    expect(rows[0]?.start_time_unix_nano).toBe("50");
    expect(rows[0]?.end_time_unix_nano).toBe("300");
  });

  it("getTraceTree_reconstructs_nested_tree_by_parent_span_id", async () => {
    await repo.save([
      span({ spanId: "root", traceId: "t1" }),
      span({ spanId: "c1", traceId: "t1", parentSpanId: "root" }),
      span({ spanId: "c2", traceId: "t1", parentSpanId: "root" }),
    ]);
    const tree = await repo.getTraceTree("t1");
    expect(tree?.spanId).toBe("root");
    expect(tree?.children.map((c) => c.spanId).sort()).toEqual(["c1", "c2"]);
  });

  it("getTraceTree_attaches_orphan_span_at_root", async () => {
    await repo.save([
      span({ spanId: "root", traceId: "t1" }),
      span({ spanId: "orphan", traceId: "t1", parentSpanId: "missing" }),
    ]);
    const tree = await repo.getTraceTree("t1");
    expect(tree?.spanId).toBe("root");
    expect(tree?.children.map((c) => c.spanId)).toContain("orphan");
  });

  it("getTraceTree_assembles_across_out_of_order_batches", async () => {
    // child ingested BEFORE parent
    await repo.save([span({ spanId: "c1", traceId: "t1", parentSpanId: "root" })]);
    await repo.save([span({ spanId: "root", traceId: "t1" })]);
    const tree = await repo.getTraceTree("t1");
    expect(tree?.spanId).toBe("root");
    expect(tree?.children.map((c) => c.spanId)).toEqual(["c1"]);
  });

  it("getTraceTree_multiple_roots_attach_extra_roots_under_earliest", async () => {
    // Documented M1 simplification (F-otlp-6): a trace with >1 root span returns
    // the earliest as the tree root; extra roots attach under it (single-tree API).
    await repo.save([
      span({ spanId: "r1", traceId: "t1", startTimeUnixNano: "100" }),
      span({ spanId: "r2", traceId: "t1", startTimeUnixNano: "50" }),
    ]);
    const tree = await repo.getTraceTree("t1");
    expect(tree?.spanId).toBe("r2"); // earliest start wins
    expect(tree?.children.map((c) => c.spanId)).toEqual(["r1"]);
  });

  it("getTraceTree_breaks_parent_cycle_without_crashing", async () => {
    // Adversarial: A.parent=B, B.parent=A. Must not produce a circular structure
    // (would 500 on JSON.stringify) — cyclic edges are severed (F-otlp-7).
    await repo.save([
      span({ spanId: "a", traceId: "t1", parentSpanId: "b" }),
      span({ spanId: "b", traceId: "t1", parentSpanId: "a" }),
    ]);
    const tree = await repo.getTraceTree("t1");
    expect(tree).not.toBeNull();
    // serializable (no cycle) — JSON.stringify must not throw
    expect(() => JSON.stringify(tree)).not.toThrow();
  });

  it("getTraceTree_breaks_self_parent_cycle", async () => {
    await repo.save([span({ spanId: "s", traceId: "t1", parentSpanId: "s" })]);
    const tree = await repo.getTraceTree("t1");
    expect(tree?.spanId).toBe("s");
    expect(() => JSON.stringify(tree)).not.toThrow();
  });

  it("repo_reingest_same_batch_keeps_trace_aggregate_stable", async () => {
    const batch = [
      span({ spanId: "a1", traceId: "t1", inputTokens: 10 }),
      span({ spanId: "a2", traceId: "t1", inputTokens: 5 }),
    ];
    await repo.save(batch);
    await repo.save(batch); // retry — must NOT double-count (recompute-from-spans, EC-1)
    const { rows } = await pool.query<{ input_tokens: number }>(
      "SELECT input_tokens FROM traces WHERE trace_id='t1'",
    );
    expect(rows[0]?.input_tokens).toBe(15);
  });

  it("listTraces_returns_traces_newest_first_with_durationMs", async () => {
    await repo.save([
      span({ spanId: "a1", traceId: "old", startTimeUnixNano: "100", endTimeUnixNano: "200", inputTokens: 3, outputTokens: 1 }),
    ]);
    await repo.save([
      span({ spanId: "b1", traceId: "new", startTimeUnixNano: "1000000", endTimeUnixNano: "6000000" }),
    ]);
    const { traces: list } = await repo.listTraces();
    expect(list.map((t) => t.traceId)).toEqual(["new", "old"]); // newest updated first
    const newest = list[0]!;
    expect(newest.durationMs).toBe(5); // (6_000_000 - 1_000_000) / 1e6 ns→ms
    const old = list[1]!;
    expect(old.totalTokens).toBe(4);
  });

  it("listTraces_omits_durationMs_when_endTime_missing", async () => {
    // A trace whose aggregate has no end time → durationMs key absent (strict DTO).
    await repo.save([span({ spanId: "a1", traceId: "t1" })]);
    await pool.query("UPDATE traces SET end_time_unix_nano = NULL WHERE trace_id='t1'");
    const { traces: list } = await repo.listTraces();
    expect(list[0]?.traceId).toBe("t1");
    expect(list[0]?.durationMs).toBeUndefined();
  });

  it("listTraces_returns_empty_array_when_no_traces", async () => {
    // Contract is the paginated envelope { traces, total, limit, offset } — asserting the full
    // shape (not just traces) proves the empty-result path still carries correct pagination metadata.
    expect(await repo.listTraces()).toEqual({ traces: [], total: 0, limit: 50, offset: 0 });
  });

  it("replay_source_tree_is_deterministic_from_persisted_session_with_parallel_tools", async () => {
    // M4: a fixture session with two PARALLEL tool calls (equal start time) under an
    // agent + an output span. The replay source (getTraceTree) must be deterministic
    // across fetches — proving replay reads persisted spans, never re-executes (DoD #2).
    await repo.save([
      span({ spanId: "agent", traceId: "s1", name: "agent", startTimeUnixNano: "100", endTimeUnixNano: "900" }),
      span({ spanId: "tool-b", traceId: "s1", parentSpanId: "agent", name: "tool-b", startTimeUnixNano: "200", endTimeUnixNano: "400" }),
      span({ spanId: "tool-a", traceId: "s1", parentSpanId: "agent", name: "tool-a", startTimeUnixNano: "200", endTimeUnixNano: "400" }),
      span({ spanId: "output", traceId: "s1", parentSpanId: "agent", name: "output", startTimeUnixNano: "500", endTimeUnixNano: "800" }),
    ]);
    const first = await repo.getTraceTree("s1");
    const second = await repo.getTraceTree("s1");
    // identical across fetches (deterministic persisted source)
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // children come back in DETERMINISTIC order (NOT .sort()ed here): equal-start
    // parallel tools by spanId (tool-a < tool-b), then the later output span.
    expect(first?.spanId).toBe("agent");
    expect(first?.children.map((c) => c.spanId)).toEqual([
      "tool-a",
      "tool-b",
      "output",
    ]);
  });

  it("ingest_fills_trace_cost_usd_from_price_table", async () => {
    // gpt-4o default: $2.5/1M in, $10/1M out → 1000*2.5e-6 + 500*10e-6 = 0.0025+0.005 = 0.0075
    await repo.save([
      span({ spanId: "a1", traceId: "t1", model: "gpt-4o", inputTokens: 1000, outputTokens: 500 }),
    ]);
    const cost = await repo.getTraceCost("t1");
    expect(cost?.costUsd).toBeCloseTo(0.0075, 9);
    expect(cost?.inputTokens).toBe(1000);
    expect(cost?.outputTokens).toBe(500);
  });

  it("ingest_unknown_model_costs_zero_but_counts_tokens", async () => {
    await repo.save([
      span({ spanId: "a1", traceId: "t1", model: "mystery-llm", inputTokens: 100, outputTokens: 50 }),
    ]);
    const cost = await repo.getTraceCost("t1");
    expect(cost?.costUsd).toBe(0);
    expect(cost?.totalTokens).toBe(150);
  });

  it("ingest_cost_is_idempotent_and_stable_under_concurrent_ingest", async () => {
    // N parallel saves of the same trace — cost equals the single-shot cost (no double count).
    const N = 10;
    await Promise.all(
      Array.from({ length: N }, () =>
        repo.save([span({ spanId: "a1", traceId: "t1", model: "gpt-4o", inputTokens: 1000, outputTokens: 0 })]),
      ),
    );
    const cost = await repo.getTraceCost("t1");
    expect(cost?.costUsd).toBeCloseTo(0.0025, 9); // 1000*2.5e-6 — counted once
  });

  it("getTraceCost_returns_null_for_absent_trace", async () => {
    expect(await repo.getTraceCost("nope")).toBeNull();
  });

  it("aggregateCostByPeriod_buckets_by_day_and_week_newest_first", async () => {
    await repo.save([span({ spanId: "a1", traceId: "older", model: "gpt-4o", inputTokens: 1000, outputTokens: 0 })]);
    await repo.save([span({ spanId: "b1", traceId: "newer", model: "gpt-4o", inputTokens: 2000, outputTokens: 0 })]);
    // Anchor both inside the CURRENT ISO week (Mon = date_trunc('week')) on distinct
    // days — deterministic regardless of the run weekday: exercises day (2 buckets) vs
    // week (1 bucket) without a week-boundary flake, and both stay inside the 90-day window.
    await pool.query("UPDATE traces SET updated_at = date_trunc('week', now()) + interval '1 day' WHERE trace_id='older'");
    await pool.query("UPDATE traces SET updated_at = date_trunc('week', now()) + interval '2 days' WHERE trace_id='newer'");

    // day → two distinct buckets, newest first (newer's day before older's day)
    const day = await repo.aggregateCostByPeriod("day");
    expect(day.period).toBe("day");
    expect(day.buckets.length).toBe(2);
    expect(day.buckets[0]!.periodStart > day.buckets[1]!.periodStart).toBe(true); // DESC
    expect(day.buckets[0]?.costUsd).toBeCloseTo(0.005, 9); // newer = 2000*2.5e-6
    expect(day.buckets[1]?.costUsd).toBeCloseTo(0.0025, 9); // older = 1000*2.5e-6

    // week → both collapse into one bucket (2 days apart = same ISO week here)
    const week = await repo.aggregateCostByPeriod("week");
    expect(week.period).toBe("week");
    expect(week.buckets.length).toBe(1);
    expect(week.buckets[0]?.traceCount).toBe(2);
    expect(week.buckets[0]?.costUsd).toBeCloseTo(0.0075, 9);
  });

  it("ingest_persists_tool_name_typed_column", async () => {
    await repo.save([
      span({ spanId: "a1", traceId: "t1", name: "search", toolName: "search" }),
    ]);
    expect((await repo.getBySpanId("a1"))?.toolName).toBe("search");
  });

  it("aggregate_tool_stats_matches_pure_fn_on_fixture", async () => {
    // durations 10/20/30/40 ms; the 30ms call errored (status_code '2').
    const mk = (id: string, durMs: number, err: boolean) =>
      span({
        spanId: id,
        traceId: "t1",
        name: "search",
        toolName: "search",
        startTimeUnixNano: "0",
        endTimeUnixNano: String(durMs * 1_000_000),
        ...(err ? { statusCode: "2" } : {}),
      });
    await repo.save([
      mk("s1", 10, false),
      mk("s2", 20, false),
      mk("s3", 30, true),
      mk("s4", 40, false),
    ]);
    const { tools } = await repo.aggregateToolStats();
    const search = tools.find((t) => t.toolName === "search");
    const expected = computeToolStats("search", [
      { durationMs: 10, errored: false },
      { durationMs: 20, errored: false },
      { durationMs: 30, errored: true },
      { durationMs: 40, errored: false },
    ]);
    // SQL percentile_cont aggregation == the pure unit-tested contract (M6 D1)
    expect(search?.callCount).toBe(expected.callCount);
    expect(search?.errorCount).toBe(expected.errorCount);
    expect(search?.errorRate).toBeCloseTo(expected.errorRate, 6);
    expect(search?.p50Ms).toBeCloseTo(expected.p50Ms, 6);
    expect(search?.p95Ms).toBeCloseTo(expected.p95Ms, 6);
  });

  it("aggregate_tool_stats_single_call_p50_equals_p95", async () => {
    await repo.save([
      span({ spanId: "s1", traceId: "t1", toolName: "once", startTimeUnixNano: "0", endTimeUnixNano: "7000000" }),
    ]);
    const { tools } = await repo.aggregateToolStats();
    const once = tools.find((t) => t.toolName === "once");
    expect(once?.p50Ms).toBe(7);
    expect(once?.p95Ms).toBe(7); // single sample → percentile_cont over one row
  });

  it("aggregate_tool_stats_counts_textual_ERROR_status", async () => {
    // A tool span whose status_code is the textual "ERROR" (not "2") must still count
    // as an error — the SQL filter matches the same tokens as the UI (review F-st-1).
    await repo.save([
      span({ spanId: "ok", traceId: "t1", toolName: "search" }),
      span({ spanId: "bad", traceId: "t1", toolName: "search", statusCode: "ERROR" }),
    ]);
    const search = (await repo.aggregateToolStats()).tools.find((t) => t.toolName === "search");
    expect(search?.callCount).toBe(2);
    expect(search?.errorCount).toBe(1);
    expect(search?.errorRate).toBe(0.5);
  });

  it("aggregate_tool_stats_caps_at_top_100_by_call_count", async () => {
    // 101 distinct tools; the least-called must be excluded by the top-100 cap (risk #2).
    const batch = Array.from({ length: 101 }, (_, i) =>
      // tool i called (i+1) times would be huge; instead give each 1 call and rely on the
      // LIMIT — assert exactly 100 returned and the count never exceeds the cap.
      span({ spanId: `s${i}`, traceId: "t1", toolName: `tool-${String(i).padStart(3, "0")}` }),
    );
    await repo.save(batch);
    const { tools } = await repo.aggregateToolStats();
    expect(tools.length).toBe(100); // top-100 cap fires (101 distinct tools ingested)
  });

  it("aggregate_tool_stats_orders_by_call_count_desc", async () => {
    await repo.save([
      span({ spanId: "a1", traceId: "t1", toolName: "alpha" }),
      span({ spanId: "a2", traceId: "t1", toolName: "alpha" }),
      span({ spanId: "a3", traceId: "t1", toolName: "alpha" }),
      span({ spanId: "b1", traceId: "t1", toolName: "beta" }),
    ]);
    const { tools } = await repo.aggregateToolStats();
    expect(tools.map((t) => t.toolName)).toEqual(["alpha", "beta"]);
    expect(tools[0]?.callCount).toBe(3);
  });

  it("list_traces_for_tool_returns_calling_executions_newest_first", async () => {
    await repo.save([span({ spanId: "x1", traceId: "calls-search", toolName: "search" })]);
    await repo.save([span({ spanId: "y1", traceId: "no-tool" })]);
    const { traces: list } = await repo.listTracesForTool("search");
    expect(list.map((t) => t.traceId)).toEqual(["calls-search"]);
  });

  it("repo_trace_aggregate_is_race_safe_under_concurrent_ingest", async () => {
    // atomic-counter invariant after a happens-before barrier (Promise.all)
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        repo.save([span({ spanId: `s${i}`, traceId: "t1", inputTokens: 1 })]),
      ),
    );
    const { rows } = await pool.query<{ in: number; cnt: string }>(
      "SELECT (SELECT input_tokens FROM traces WHERE trace_id='t1') AS in, (SELECT count(*)::text FROM spans WHERE trace_id='t1') AS cnt",
    );
    expect(rows[0]?.cnt).toBe(String(N));
    expect(rows[0]?.in).toBe(N);
  });
});
