import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { Span } from "../../../domain/observability/span.js";
import { createPool, DrizzleSpanRepository } from "./drizzle-span-repository.js";
import { getTraceTree } from "./trace-read-repository.js";

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

// M53 / looptrace#73: the trace-detail tree root must carry the trace's STORED cost so the
// detail header matches the list (both read the same authoritative `traces.cost_usd`), instead
// of the detail re-summing per-span costs (which are absent for interaction/tool spans → $0.0000).
suite("getTraceTree attaches the stored trace cost to the root (M53 / #73)", () => {
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

  it("test_root_carries_stored_trace_cost_even_when_root_span_has_no_model", async () => {
    // The exact #73 shape: an interaction root with NO model/tokens + a child llm_request that
    // carries the tokens. Ingest computes `traces.cost_usd` from the child; the tree root must
    // surface it.
    await repo.save([
      span({ spanId: "root", traceId: "tc1", name: "claude_code.interaction" }),
      span({
        spanId: "child",
        traceId: "tc1",
        parentSpanId: "root",
        name: "claude_code.llm_request",
        model: "claude-opus-4-8",
        inputTokens: 1000,
        outputTokens: 2000,
      }),
    ]);
    const root = await getTraceTree(db, "tc1");
    expect(root?.spanId).toBe("root");
    // trace cost = child's: 1000·$5/M + 2000·$25/M = 0.005 + 0.05 = 0.055 (no cache tokens here)
    expect(root?.costUsd).toBeCloseTo(0.055, 6);
  });

  it("test_root_cost_is_absent_when_trace_has_no_computed_cost", async () => {
    // A trace whose spans carry no priced model → stored cost is 0 → the root carries no cost
    // (undefined), so the UI renders an em-dash, never a fabricated $0.0000.
    await repo.save([span({ spanId: "s0", traceId: "tc0", name: "claude_code.tool" })]);
    const root = await getTraceTree(db, "tc0");
    expect(root?.costUsd).toBeUndefined();
  });
});
