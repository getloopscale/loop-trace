/**
 * Tenant isolation for the read surface — the invariant with no second line of defence.
 *
 * WHY THIS FILE EXISTS (measured 2026-08-02, mutation sweep over `trace-read-repository.ts`):
 * removing the workspace filter from ALL 11 scoped queries killed only 1 of 145 integration tests.
 * Per function:
 *
 *   getBySpanId          →  0 tests died   ← nothing protected `GET /v1/spans/:spanId`
 *   listTracesForTool    →  0 tests died   ← nothing protected the tool drill-down
 *   listTraces           →  2 tests died
 *   getTraceCost         →  1 test  died
 *
 * The filter IS present in the code today — this is not a live leak. What was missing is anything
 * stopping a refactor from dropping it. A cross-tenant leak surfaces as a plausible span, not as an
 * error, so nobody would notice until a customer did.
 *
 * SHAPE THAT DISCRIMINATES: every id below is REAL in workspace A. Asserting that a MADE-UP id is
 * unreachable would pass against an implementation with no scoping at all — an id that exists in no
 * tenant proves nothing about the lock. Each case also asserts the id IS reachable from its own
 * workspace, so the test cannot pass for the degenerate reason that nothing is reachable anywhere.
 */
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import type pg from "pg";

import type { Span } from "../../../domain/observability/span.js";
import { createPool, DrizzleSpanRepository } from "./drizzle-span-repository.js";

const PG_URI = process.env["LOOPTRACE_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const suite = PG_URI ? describe : describe.skip;

const OWNER = "ws-isolation-owner";
const INTRUDER = "ws-isolation-intruder";

function span(over: Partial<Span> & Pick<Span, "spanId" | "traceId">): Span {
  return {
    name: "op",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
    ...over,
  };
}

suite("tenant isolation — the read surface (integration)", () => {
  let pool: pg.Pool;
  let db: NodePgDatabase;
  let repo: DrizzleSpanRepository;

  beforeAll(async () => {
    pool = createPool(PG_URI as string);
    db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    repo = new DrizzleSpanRepository(db);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    for (const ws of [OWNER, INTRUDER]) {
      await db.execute(sql`DELETE FROM spans WHERE workspace_id = ${ws}`);
      await db.execute(sql`DELETE FROM traces WHERE workspace_id = ${ws}`);
    }
  });

  it("getBySpanId — a span id from another workspace is not readable", async () => {
    // KILLS the mutation that dropped `eq(spans.workspaceId, workspaceId)` at line 169, which
    // survived all 145 tests. Serves `GET /v1/spans/:spanId`.
    await repo.save([span({ spanId: "owned-span", traceId: "owned-trace", name: "secret-op" })], OWNER);

    expect(await repo.getBySpanId("owned-span", OWNER), "owner must reach its own span").not.toBeNull();
    expect(await repo.getBySpanId("owned-span", INTRUDER)).toBeNull();
  });

  it("listTracesForTool — the tool drill-down never crosses the tenant boundary", async () => {
    // KILLS the mutation at line 542, which also survived all 145 tests.
    await repo.save(
      [span({ spanId: "tool-span", traceId: "tool-trace", toolName: "shared-tool-name" })],
      OWNER,
    );

    const own = await repo.listTracesForTool("shared-tool-name", 50, OWNER);
    expect(own.traces.map((t) => t.traceId), "owner must see its own drill-down").toContain("tool-trace");

    const foreign = await repo.listTracesForTool("shared-tool-name", 50, INTRUDER);
    expect(foreign.traces.map((t) => t.traceId)).not.toContain("tool-trace");
  });

  it("the same tool name in two workspaces returns only the caller's traces", async () => {
    // Sharper than "the intruder sees nothing": both tenants legitimately use a tool with the SAME
    // name — the realistic case, since tool names are conventions, not identifiers. An
    // implementation that filtered by name alone would return both and look perfectly plausible.
    await repo.save([span({ spanId: "a-1", traceId: "trace-a", toolName: "web_search" })], OWNER);
    await repo.save([span({ spanId: "b-1", traceId: "trace-b", toolName: "web_search" })], INTRUDER);

    const asOwner = await repo.listTracesForTool("web_search", 50, OWNER);
    const asIntruder = await repo.listTracesForTool("web_search", 50, INTRUDER);

    expect(asOwner.traces.map((t) => t.traceId)).toEqual(["trace-a"]);
    expect(asIntruder.traces.map((t) => t.traceId)).toEqual(["trace-b"]);
  });

  it("a span id that exists in NO workspace is unreachable from everywhere", async () => {
    // Guard-the-guard, and deliberately marked as the WEAK case: on its own it proves nothing,
    // because a made-up id is absent from every tenant. It is here only so a fix that starts
    // returning rows for unknown ids cannot hide behind the strong cases above.
    expect(await repo.getBySpanId("span-that-never-existed", OWNER)).toBeNull();
    expect(await repo.getBySpanId("span-that-never-existed", INTRUDER)).toBeNull();
  });
});
