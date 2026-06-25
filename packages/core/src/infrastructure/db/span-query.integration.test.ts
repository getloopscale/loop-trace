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

const TOOL_ATTR = { "gen_ai.tool.name": "hidden_gems" };
const RETRIEVE_ATTR = { "gen_ai.operation.name": "retrieve" };
const CHAT_ATTR = { "gen_ai.operation.name": "chat" };
const EMBED_ATTR = { "gen_ai.operation.name": "embedding" };

suite("listTraces span-query DSL (integration, M30)", () => {
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

  async function ids(spanQuery: string): Promise<string[]> {
    const { traces } = await repo.listTraces({ spanQuery });
    return traces.map((t) => t.traceId).sort();
  }

  /** Distinct traces, each demonstrating one derived kind (+ a chain root with an llm child). */
  async function seedKinds(): Promise<void> {
    await repo.save([
      span({ spanId: "llm1", traceId: "t-llm", name: "ChatOpenAI", model: "gpt-4o", attributes: CHAT_ATTR }),
    ]);
    await repo.save([
      span({ spanId: "tool1", traceId: "t-tool", name: "hidden_gems", attributes: TOOL_ATTR }),
    ]);
    await repo.save([
      span({ spanId: "ret1", traceId: "t-ret", name: "VectorStoreRetriever", attributes: RETRIEVE_ATTR }),
    ]);
    // a chain root (no signals, HAS a child) with an llm child — kind:chain matches the root,
    // kind:llm matches via the child.
    await repo.save([
      span({ spanId: "root1", traceId: "t-chain", name: "TripAgentGraph" }),
      span({ spanId: "child1", traceId: "t-chain", parentSpanId: "root1", name: "ChatOpenAI", model: "gpt-4o", attributes: CHAT_ATTR }),
    ]);
    // embedding span (gen_ai.operation.name = 'embedding')
    await repo.save([
      span({ spanId: "emb1", traceId: "t-emb", name: "Embed", attributes: EMBED_ATTR }),
    ]);
    // unknown span: no signals, no model, no children → derives to 'unknown'
    await repo.save([
      span({ spanId: "unk1", traceId: "t-unknown", name: "noisy" }),
    ]);
  }

  it("test_span_query_kind_matches_derived_kind", async () => {
    await seedKinds();
    // llm: the standalone llm trace + the chain trace (has an llm child span)
    expect(await ids("kind:llm")).toEqual(["t-chain", "t-llm"]);
    expect(await ids("kind:tool")).toEqual(["t-tool"]);
    expect(await ids("kind:retriever")).toEqual(["t-ret"]);
    // chain: only the trace whose span has children
    expect(await ids("kind:chain")).toEqual(["t-chain"]);
    // embedding + unknown: the two remaining CASE branches (F-test-1)
    expect(await ids("kind:embedding")).toEqual(["t-emb"]);
    expect(await ids("kind:unknown")).toEqual(["t-unknown"]);
  });

  it("test_span_query_status_ok_includes_null_status_span", async () => {
    // F-test-2: the span-scoped status:ok branch is `IS NULL OR NOT IN (errors)` — a
    // NULL-status span must count as ok (the M9 EC-1 NULL-drop bug class, span-scoped).
    await repo.save([span({ spanId: "ok-null", traceId: "t-okspan" })]); // status_code NULL
    await repo.save([span({ spanId: "err1", traceId: "t-errspan", statusCode: "2" })]);
    expect(await ids("status:ok")).toEqual(["t-okspan"]);
    expect(await ids("status:error")).toEqual(["t-errspan"]);
  });

  it("test_span_query_clause_and_is_span_scoped", async () => {
    // t-AB: an ERRORED TOOL span + an OK LLM span (no single span is both errored AND llm)
    await repo.save([
      span({ spanId: "ab-tool", traceId: "t-AB", statusCode: "2", attributes: TOOL_ATTR }),
      span({ spanId: "ab-llm", traceId: "t-AB", name: "ChatOpenAI", model: "gpt-4o", attributes: CHAT_ATTR }),
    ]);
    // t-B: a single ERRORED LLM span (one span is both)
    await repo.save([
      span({ spanId: "b-llm", traceId: "t-B", statusCode: "2", name: "ChatOpenAI", model: "gpt-4o", attributes: CHAT_ATTR }),
    ]);
    // span-scoped AND: only t-B has ONE span that is both errored and llm
    expect(await ids("status:error kind:llm")).toEqual(["t-B"]);
  });

  it("test_span_query_model_and_name", async () => {
    await seedKinds();
    expect(await ids("model:gpt-4o")).toEqual(["t-chain", "t-llm"]);
    expect(await ids("name:VectorStoreRetriever")).toEqual(["t-ret"]);
  });

  it("test_span_query_garbage_returns_unfiltered", async () => {
    await seedKinds();
    // a query with no VALID clauses (all ignored) adds no condition → lists everything
    const garbage = await ids("foo:bar zzz kind:wizard");
    const { traces } = await repo.listTraces({});
    expect(garbage.length).toBe(traces.length);
    expect(garbage.length).toBeGreaterThan(0);
  });

  it("test_span_query_composes_with_trace_status", async () => {
    await seedKinds();
    // add an errored llm trace so status:error narrows the kind:llm set
    await repo.save([
      span({ spanId: "err-llm", traceId: "t-errllm", statusCode: "2", model: "gpt-4o", attributes: CHAT_ATTR }),
    ]);
    const { traces } = await repo.listTraces({ status: "error", spanQuery: "kind:llm" });
    expect(traces.map((t) => t.traceId)).toEqual(["t-errllm"]);
  });
});
