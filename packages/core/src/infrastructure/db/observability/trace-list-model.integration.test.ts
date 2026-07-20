import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { Span } from "../../../domain/observability/span.js";
import { createPool, DrizzleSpanRepository } from "./drizzle-span-repository.js";
import { listTraces } from "./trace-read-repository.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
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

// M53 / theo-lens#76: the trace list must attribute a MODEL to `interaction` traces (whose ROOT
// span has no model — the model lives on the child llm_request spans). Derive the DOMINANT model
// (most tokens) instead of the root-span model.
suite("listTraces derives the dominant child model for interaction traces (M53 / #76)", () => {
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

  it("test_interaction_trace_shows_the_dominant_child_model_not_empty", async () => {
    // interaction root has NO model; opus child has far more tokens than the haiku child →
    // the list model must be the dominant one (opus), not empty/"—".
    await repo.save([
      span({ spanId: "root", traceId: "ti", name: "claude_code.interaction" }),
      span({
        spanId: "opus",
        traceId: "ti",
        parentSpanId: "root",
        name: "claude_code.llm_request",
        model: "claude-opus-4-8",
        inputTokens: 5000,
        outputTokens: 5000,
      }),
      span({
        spanId: "haiku",
        traceId: "ti",
        parentSpanId: "root",
        name: "claude_code.llm_request",
        model: "claude-haiku-4-5",
        inputTokens: 100,
        outputTokens: 50,
      }),
    ]);
    const res = await listTraces(db, {});
    const item = res.traces.find((t) => t.traceId === "ti");
    expect(item?.model).toBe("claude-opus-4-8");
  });

  it("test_single_model_llm_request_trace_still_shows_its_model", async () => {
    await repo.save([
      span({
        spanId: "s",
        traceId: "tl",
        name: "claude_code.llm_request",
        model: "claude-sonnet-4-6",
        inputTokens: 10,
        outputTokens: 10,
      }),
    ]);
    const res = await listTraces(db, {});
    expect(res.traces.find((t) => t.traceId === "tl")?.model).toBe("claude-sonnet-4-6");
  });

  it("test_trace_with_no_model_spans_has_no_model", async () => {
    await repo.save([span({ spanId: "t0", traceId: "tt", name: "claude_code.tool" })]);
    const res = await listTraces(db, {});
    expect(res.traces.find((t) => t.traceId === "tt")?.model).toBeUndefined();
  });
});
