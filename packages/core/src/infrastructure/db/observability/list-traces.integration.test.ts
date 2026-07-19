import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { Span } from "../../../domain/observability/span.js";
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

  it("test_list_traces_limit_offset_pages_disjointly (M56 export pagination)", async () => {
    await seed(); // ≥ 3 traces
    const page1 = await repo.listTraces({ limit: 2, offset: 0 });
    const page2 = await repo.listTraces({ limit: 2, offset: 2 });
    expect(page1.traces).toHaveLength(2);
    expect(page2.traces.length).toBeGreaterThanOrEqual(1);
    // the two pages do NOT overlap — offset advances the window (the export's contract).
    const p1 = new Set(page1.traces.map((t) => t.traceId));
    expect(page2.traces.every((t) => !p1.has(t.traceId))).toBe(true);
  });

  it("test_list_traces_returns_total_stable_across_pages (M81)", async () => {
    await seed(); // 6 traces in the default workspace
    const page1 = await repo.listTraces({ limit: 2, offset: 0 });
    const page2 = await repo.listTraces({ limit: 2, offset: 2 });
    // the total is the FULL workspace count over the (empty) filter — not the page size — and is
    // identical across pages of the same filter; the applied window is echoed back.
    expect(page1.total).toBe(6);
    expect(page2.total).toBe(6);
    expect(page1.limit).toBe(2);
    expect(page1.offset).toBe(0);
    expect(page2.offset).toBe(2);
  });

  it("test_list_traces_total_honors_the_filter (M81)", async () => {
    await seed();
    const errs = await repo.listTraces({ status: "error" });
    // total counts only the filtered set (1 error trace), never the whole table.
    expect(errs.total).toBe(1);
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

  it("test_list_traces_filters_by_cost_range (M52)", async () => {
    await seed();
    await pool.query("UPDATE traces SET cost_usd = 0.05 WHERE trace_id = 't-ok'");
    await pool.query("UPDATE traces SET cost_usd = 5.00 WHERE trace_id = 't-err'");
    const { traces } = await repo.listTraces({ minCostUsd: 1, maxCostUsd: 10 });
    expect(traces.map((t) => t.traceId)).toEqual(["t-err"]);
  });

  it("test_list_traces_filters_by_token_range (M52)", async () => {
    await seed();
    await pool.query("UPDATE traces SET total_tokens = 50 WHERE trace_id = 't-ok'");
    await pool.query("UPDATE traces SET total_tokens = 5000 WHERE trace_id = 't-err'");
    const { traces } = await repo.listTraces({ minTokens: 1000 });
    expect(traces.map((t) => t.traceId)).toEqual(["t-err"]);
  });

  it("test_list_traces_filters_by_session (M52)", async () => {
    await seed();
    await pool.query("UPDATE traces SET session_id = 'sess-x' WHERE trace_id = 't-ok'");
    const { traces } = await repo.listTraces({ sessionId: "sess-x" });
    expect(traces.map((t) => t.traceId)).toEqual(["t-ok"]);
  });

  it("test_list_traces_inverted_cost_range_returns_empty (M52)", async () => {
    await seed();
    await pool.query("UPDATE traces SET cost_usd = 1.00 WHERE trace_id = 't-ok'");
    const { traces } = await repo.listTraces({ minCostUsd: 10, maxCostUsd: 1 });
    expect(traces).toEqual([]); // min > max → fail-soft empty
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

  it("test_list_traces_latency_clamps_clock_skew_to_zero", async () => {
    // F-data-1/F-test-1: a clock-skewed span (end < start) must clamp to 0, so it
    // does NOT lead the descending-latency list (it ranks with the fastest).
    await repo.save([
      span({
        spanId: "k1",
        traceId: "t-skew",
        startTimeUnixNano: "1700000000900000000",
        endTimeUnixNano: "1700000000000000000", // end < start
      }),
    ]);
    await repo.save([
      span({
        spanId: "sl1",
        traceId: "t-slow2",
        startTimeUnixNano: "1700000000000000000",
        endTimeUnixNano: "1700000000900000000",
      }),
    ]);
    const { traces } = await repo.listTraces({ orderBy: "latency", dir: "desc" });
    expect(traces[0]?.traceId).toBe("t-slow2"); // skew clamped to 0, never leads
  });

  it("test_list_traces_sorts_by_latency_asc_inverts_order", async () => {
    // F-test-3: dir=asc must reverse the order (fast before slow).
    await repo.save([
      span({ spanId: "fa1", traceId: "t-f", startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000010000000" }),
    ]);
    await repo.save([
      span({ spanId: "sa1", traceId: "t-s", startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000900000000" }),
    ]);
    const { traces } = await repo.listTraces({ orderBy: "latency", dir: "asc" });
    const ids = traces.map((t) => t.traceId);
    expect(ids.indexOf("t-f")).toBeLessThan(ids.indexOf("t-s"));
  });

  it("test_list_traces_sorts_by_tokens_and_cost", async () => {
    // F-test-2: tokens + cost sort columns over real PG.
    await repo.save([
      span({ spanId: "hi", traceId: "t-hi", model: "gpt-4o", inputTokens: 100, outputTokens: 100 }),
    ]);
    await repo.save([
      span({ spanId: "lo", traceId: "t-lo", model: "gpt-4o", inputTokens: 1, outputTokens: 1 }),
    ]);
    const byTokens = await repo.listTraces({ orderBy: "tokens", dir: "desc" });
    expect(byTokens.traces[0]?.traceId).toBe("t-hi");
    const byCost = await repo.listTraces({ orderBy: "cost", dir: "desc" });
    expect(byCost.traces[0]?.traceId).toBe("t-hi"); // more tokens → higher cost
  });

  it("test_list_traces_inverted_range_returns_empty", async () => {
    // F-test-6 / EC-5: from > to yields an empty result (honest), not an error.
    await repo.save([span({ spanId: "iv1", traceId: "t-iv" })]);
    const from = new Date(Date.now() + 3600_000).toISOString(); // 1h in the future
    const to = new Date(Date.now() - 3600_000).toISOString(); // 1h in the past
    const { traces } = await repo.listTraces({ from, to });
    expect(traces).toEqual([]);
  });
});

suite("listTraces enrichment (integration, M18)", () => {
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

  it("list_trace_item_carries_enriched_fields", async () => {
    await repo.save([
      span({
        spanId: "root",
        traceId: "t-rich",
        model: "gpt-4o",
        attributes: { "gen_ai.operation.name": "chat" },
        inputValue: "the user prompt",
        outputValue: "the model answer",
        inputTokens: 100,
        outputTokens: 50,
      }),
    ]);
    const { traces } = await repo.listTraces({});
    const row = traces.find((t) => t.traceId === "t-rich");
    expect(row).toBeDefined();
    expect(row?.model).toBe("gpt-4o");
    expect(row?.rootOperationName).toBe("chat");
    expect(row?.inputPreview).toBe("the user prompt");
    expect(row?.outputPreview).toBe("the model answer");
    expect(typeof row?.costUsd).toBe("number");
    expect(row?.endTimeUnixNano).toBe("1700000000100000000");
  });

  it("test_list_representative_io_prefers_root_when_present", async () => {
    // M35: root has I/O (demo/langfuse shape) → the preview is the ROOT's, even
    // though a later child also has different I/O. No regression.
    await repo.save([
      span({
        spanId: "root",
        traceId: "t-rootio",
        startTimeUnixNano: "1700000000000000000",
        inputValue: "ROOT prompt",
        outputValue: "ROOT answer",
      }),
      span({
        spanId: "child",
        traceId: "t-rootio",
        parentSpanId: "root",
        startTimeUnixNano: "1700000000050000000",
        inputValue: "child input",
        outputValue: "child output",
      }),
    ]);
    const { traces } = await repo.listTraces({});
    const row = traces.find((t) => t.traceId === "t-rootio");
    expect(row?.inputPreview).toBe("ROOT prompt");
    expect(row?.outputPreview).toBe("ROOT answer");
  });

  it("test_list_representative_io_falls_back_to_child", async () => {
    // M35: a Claude-shape trace — root llm_request has NO I/O; its first tool child
    // carries the command + result → the preview falls back to the child's I/O.
    await repo.save([
      span({
        spanId: "llm",
        traceId: "t-claude",
        name: "claude_code.llm_request",
        startTimeUnixNano: "1700000000000000000",
        model: "claude-opus-4-8",
      }),
      span({
        spanId: "tool",
        traceId: "t-claude",
        parentSpanId: "llm",
        name: "claude_code.tool",
        toolName: "Bash",
        startTimeUnixNano: "1700000000050000000",
        inputValue: "echo hi",
        outputValue: "hi\n",
      }),
    ]);
    const { traces } = await repo.listTraces({});
    const row = traces.find((t) => t.traceId === "t-claude");
    expect(row?.inputPreview).toBe("echo hi");
    expect(row?.outputPreview).toBe("hi\n");
    // kind stays root-derived: the root is llm_request (no tool_name) → model present.
    expect(row?.model).toBe("claude-opus-4-8");
    expect(row?.rootToolName).toBeUndefined();
  });

  it("test_list_representative_io_picks_earliest_child_by_start", async () => {
    // M35 tie-break: root has no I/O; two children both carry I/O, inserted out of
    // start order → the EARLIEST by start_time wins (the secondary ORDER BY), not
    // insertion order. Real Claude traces have many tool children.
    await repo.save([
      span({
        spanId: "llm",
        traceId: "t-tie",
        name: "claude_code.llm_request",
        startTimeUnixNano: "1700000000000000000",
        model: "claude-opus-4-8",
      }),
      span({
        spanId: "later",
        traceId: "t-tie",
        parentSpanId: "llm",
        startTimeUnixNano: "1700000000050000000",
        inputValue: "LATER cmd",
        outputValue: "later out",
      }),
      span({
        spanId: "earlier",
        traceId: "t-tie",
        parentSpanId: "llm",
        startTimeUnixNano: "1700000000030000000",
        inputValue: "EARLIER cmd",
        outputValue: "earlier out",
      }),
    ]);
    const { traces } = await repo.listTraces({});
    const row = traces.find((t) => t.traceId === "t-tie");
    expect(row?.inputPreview).toBe("EARLIER cmd"); // start 030 < 050
    expect(row?.outputPreview).toBe("earlier out");
  });

  it("test_list_representative_io_handles_output_only_child", async () => {
    // M35: the WHERE admits one-sided I/O (input OR output) — a child with ONLY
    // output (no input) is a valid representative; inputPreview stays absent.
    await repo.save([
      span({
        spanId: "llm",
        traceId: "t-outonly",
        name: "claude_code.llm_request",
        startTimeUnixNano: "1700000000000000000",
      }),
      span({
        spanId: "tool",
        traceId: "t-outonly",
        parentSpanId: "llm",
        startTimeUnixNano: "1700000000050000000",
        outputValue: "result only",
      }),
    ]);
    const { traces } = await repo.listTraces({});
    const row = traces.find((t) => t.traceId === "t-outonly");
    expect(row?.outputPreview).toBe("result only");
    expect(row?.inputPreview).toBeUndefined();
  });

  it("test_list_no_io_anywhere_omits_preview", async () => {
    // M35: a trace whose spans carry no input/output at all → preview omitted.
    await repo.save([
      span({ spanId: "r", traceId: "t-noio", startTimeUnixNano: "1700000000000000000" }),
      span({ spanId: "c", traceId: "t-noio", parentSpanId: "r" }),
    ]);
    const { traces } = await repo.listTraces({});
    const row = traces.find((t) => t.traceId === "t-noio");
    expect(row?.inputPreview).toBeUndefined();
    expect(row?.outputPreview).toBeUndefined();
  });

  it("list_trace_item_omits_enriched_fields_when_absent", async () => {
    // a trace whose only span has a parent → NO root span → root-derived fields omitted
    await repo.save([
      span({ spanId: "child", traceId: "t-noroot", parentSpanId: "ghost" }),
    ]);
    const { traces } = await repo.listTraces({});
    const row = traces.find((t) => t.traceId === "t-noroot");
    expect(row).toBeDefined();
    expect(row?.model).toBeUndefined();
    expect(row?.rootOperationName).toBeUndefined();
    expect(row?.rootToolName).toBeUndefined();
    expect(row?.inputPreview).toBeUndefined();
    expect(row?.outputPreview).toBeUndefined();
    // traces-column fields still present (no LATERAL dependency)
    expect(row?.endTimeUnixNano).toBe("1700000000100000000");
  });

  it("list_trace_item_truncates_long_input_preview", async () => {
    await repo.save([
      span({ spanId: "root", traceId: "t-long", inputValue: "x".repeat(200) }),
    ]);
    const { traces } = await repo.listTraces({});
    const row = traces.find((t) => t.traceId === "t-long");
    // 120 chars + the ellipsis
    expect(row?.inputPreview).toHaveLength(121);
    expect(row?.inputPreview?.endsWith("…")).toBe(true);
  });

  it("list_traces_full_text_matches_child_span_content", async () => {
    // D1: the ROOT span has NO text; a CHILD span carries the prompt. q must match
    // the child (all-spans search), not just the root.
    await repo.save([
      span({ spanId: "root", traceId: "t-fts", name: "agent" }),
      span({
        spanId: "child",
        traceId: "t-fts",
        parentSpanId: "root",
        inputValue: "please reschedule my flight to Lisbon next week",
      }),
    ]);
    await repo.save([span({ spanId: "o", traceId: "t-other", inputValue: "weather in Paris" })]);
    const { traces } = await repo.listTraces({ q: "lisbon flight" });
    expect(traces.map((t) => t.traceId)).toContain("t-fts");
    expect(traces.map((t) => t.traceId)).not.toContain("t-other");
  });

  it("list_traces_search_is_case_and_stem_insensitive", async () => {
    // EC-4: english stemming + lowercasing — "FLIGHTS" matches q="flight".
    await repo.save([
      span({ spanId: "a", traceId: "t-stem", inputValue: "Reschedule my FLIGHTS now" }),
    ]);
    const { traces } = await repo.listTraces({ q: "flight" });
    expect(traces.map((t) => t.traceId)).toContain("t-stem");
  });

  it("list_traces_search_no_match_returns_empty", async () => {
    await repo.save([span({ spanId: "a", traceId: "t1", inputValue: "hello world" })]);
    const { traces } = await repo.listTraces({ q: "zzzznomatchzzzz" });
    expect(traces).toHaveLength(0);
  });

  it("list_traces_search_malformed_query_does_not_throw", async () => {
    // D3: websearch_to_tsquery is total — garbage never 500s.
    await repo.save([span({ spanId: "a", traceId: "t1", inputValue: "hello world" })]);
    await expect(repo.listTraces({ q: 'a & & -" )(' })).resolves.toBeDefined();
  });

  it("list_traces_search_skips_textless_spans", async () => {
    // EC-3: a trace with only textless spans never matches (empty tsvector, no crash).
    await repo.save([span({ spanId: "a", traceId: "t-empty" })]);
    const { traces } = await repo.listTraces({ q: "anything" });
    expect(traces.map((t) => t.traceId)).not.toContain("t-empty");
  });

  it("list_traces_search_relevance_orders_best_match_first", async () => {
    // D4: with q set and no explicit sort, the denser match ranks first.
    await repo.save([
      span({ spanId: "d", traceId: "t-dense", inputValue: "lisbon lisbon lisbon trip to lisbon" }),
    ]);
    await repo.save([
      span({ spanId: "s", traceId: "t-sparse", inputValue: "a quick note mentioning lisbon once" }),
    ]);
    const { traces } = await repo.listTraces({ q: "lisbon" });
    expect(traces[0]?.traceId).toBe("t-dense");
  });

  it("list_traces_search_composes_with_status_filter", async () => {
    // q ANDs with the M9 status filter.
    await repo.save([
      span({ spanId: "e", traceId: "t-err", statusCode: "2", inputValue: "lisbon error path" }),
    ]);
    await repo.save([
      span({ spanId: "k", traceId: "t-ok", statusCode: "1", inputValue: "lisbon ok path" }),
    ]);
    const { traces } = await repo.listTraces({ q: "lisbon", status: "error" });
    expect(traces.map((t) => t.traceId)).toEqual(["t-err"]);
  });
});
