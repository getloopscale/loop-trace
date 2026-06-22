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

suite("rich span detail persistence (integration, M12)", () => {
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

  it("test_integration_input_output_events_roundtrip", async () => {
    await repo.save([
      span({
        spanId: "s1",
        traceId: "t1",
        inputValue: "what is 2+2?",
        outputValue: "4",
        events: [
          { name: "chunk", timeUnixNano: "1700000000050000000", attributes: { i: 1 } },
        ],
      }),
    ]);
    const read = await repo.getBySpanId("s1");
    expect(read?.inputValue).toBe("what is 2+2?");
    expect(read?.outputValue).toBe("4");
    expect(read?.events).toHaveLength(1);
    expect(read?.events?.[0]).toMatchObject({ name: "chunk", attributes: { i: 1 } });
  });

  it("test_integration_oversized_input_truncated", async () => {
    // The domain caps at extraction; here we assert a capped value persists +
    // reads back intact (≤ 8192 code points + marker), no pg encoding error.
    const capped = "a".repeat(8192) + "…[truncated]";
    await repo.save([span({ spanId: "s2", traceId: "t2", inputValue: capped })]);
    const read = await repo.getBySpanId("s2");
    expect(read?.inputValue).toBe(capped);
    expect([...read!.inputValue!].length).toBeLessThanOrEqual(8192 + "…[truncated]".length);
  });

  it("test_integration_span_without_new_fields_roundtrips", async () => {
    await repo.save([span({ spanId: "s3", traceId: "t3" })]);
    const read = await repo.getBySpanId("s3");
    expect(read?.inputValue).toBeUndefined();
    expect(read?.outputValue).toBeUndefined();
    expect(read?.events).toBeUndefined();
    expect(read?.spanId).toBe("s3"); // existing span shape intact (backward-compat)
  });

  it("test_integration_get_trace_tree_returns_rich_fields", async () => {
    await repo.save([
      span({ spanId: "root", traceId: "tt", inputValue: "in", outputValue: "out" }),
    ]);
    const tree = await repo.getTraceTree("tt");
    expect(tree?.inputValue).toBe("in");
    expect(tree?.outputValue).toBe("out");
  });
});
