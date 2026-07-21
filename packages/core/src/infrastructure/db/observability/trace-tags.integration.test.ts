import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { Span } from "../../../domain/observability/span.js";
import { createPool, DrizzleSpanRepository } from "./drizzle-span-repository.js";

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

suite("trace tags (integration, M14)", () => {
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
    await pool.query("TRUNCATE spans, traces, sessions, replay_sessions, trace_tags");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("test_tag_lifecycle_add_filter_remove", async () => {
    await repo.save([span({ spanId: "a", traceId: "t1" })]);
    expect(await repo.addTag("t1", "prod")).toBe(true);
    // filter the list to the tagged trace
    const filtered = await repo.listTraces({ tag: "prod" });
    expect(filtered.traces.map((t) => t.traceId)).toEqual(["t1"]);
    // remove → filter is empty
    await repo.removeTag("t1", "prod");
    const after = await repo.listTraces({ tag: "prod" });
    expect(after.traces).toEqual([]);
  });

  it("test_add_tag_idempotent_on_duplicate", async () => {
    await repo.save([span({ spanId: "a", traceId: "t1" })]);
    await repo.addTag("t1", "dup");
    await repo.addTag("t1", "dup"); // idempotent — no error, no second row
    expect(await repo.listTags("t1")).toEqual(["dup"]);
  });

  it("test_add_tag_absent_trace_returns_false", async () => {
    expect(await repo.addTag("does-not-exist", "x")).toBe(false);
    // nothing was inserted
    expect(await repo.listTags("does-not-exist")).toEqual([]);
  });

  it("test_list_tags_untagged_trace_is_empty", async () => {
    await repo.save([span({ spanId: "a", traceId: "t1" })]);
    expect(await repo.listTags("t1")).toEqual([]);
  });

  it("test_tag_filter_composes_with_status", async () => {
    await repo.save([span({ spanId: "ok", traceId: "t-ok", statusCode: "1" })]);
    await repo.save([span({ spanId: "err", traceId: "t-err", statusCode: "2" })]);
    await repo.addTag("t-ok", "rel");
    await repo.addTag("t-err", "rel");
    // tag=rel AND status=error → only the errored trace
    const r = await repo.listTraces({ tag: "rel", status: "error" });
    expect(r.traces.map((t) => t.traceId)).toEqual(["t-err"]);
  });

  it("test_remove_tag_idempotent_when_absent", async () => {
    await repo.save([span({ spanId: "a", traceId: "t1" })]);
    await expect(repo.removeTag("t1", "never-added")).resolves.toBeUndefined();
  });

  it("test_list_tags_deterministic_order", async () => {
    await repo.save([span({ spanId: "a", traceId: "t1" })]);
    await repo.addTag("t1", "zebra");
    await repo.addTag("t1", "alpha");
    await repo.addTag("t1", "mango");
    expect(await repo.listTags("t1")).toEqual(["alpha", "mango", "zebra"]); // ORDER BY tag
  });

  it("test_tag_with_slash_round_trips", async () => {
    // free-form tags include slashes (EC-1 — handled via query param at the route).
    await repo.save([span({ spanId: "a", traceId: "t1" })]);
    await repo.addTag("t1", "area/auth");
    expect(await repo.listTags("t1")).toEqual(["area/auth"]);
    await repo.removeTag("t1", "area/auth");
    expect(await repo.listTags("t1")).toEqual([]);
  });
});
