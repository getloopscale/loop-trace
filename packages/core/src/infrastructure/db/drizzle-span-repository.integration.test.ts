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
    await pool.query("TRUNCATE spans, traces, sessions");
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
    expect(await repo.listTraces()).toEqual({ traces: [] });
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
    // every persisted span is present under the agent (gap-free)
    expect(first?.spanId).toBe("agent");
    expect(first?.children.map((c) => c.spanId).sort()).toEqual([
      "output",
      "tool-a",
      "tool-b",
    ]);
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
