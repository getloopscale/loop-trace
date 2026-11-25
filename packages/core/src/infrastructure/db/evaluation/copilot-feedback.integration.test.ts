import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { Span } from "../../../domain/observability/span.js";
import { createPool, DrizzleSpanRepository } from "../observability/drizzle-span-repository.js";

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

suite("copilot feedback (integration, M83)", () => {
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
    await pool.query("TRUNCATE spans, traces, sessions, copilot_feedback");
  });
  afterAll(async () => {
    await pool.end();
  });

  it("records a thumbs-up feedback for a turn", async () => {
    const rec = await repo.recordAskFeedback("t1", { turnId: "turn-1", label: "up", question: "why?" });
    expect(rec).toMatchObject({ traceId: "t1", turnId: "turn-1", label: "up", question: "why?" });
    expect(rec.id).toBeTruthy();
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM copilot_feedback");
    expect(rows[0].n).toBe(1);
  });

  it("a re-vote UPSERTs the label (up→down toggle), never a duplicate row", async () => {
    const up = await repo.recordAskFeedback("t1", { turnId: "turn-1", label: "up" });
    const down = await repo.recordAskFeedback("t1", { turnId: "turn-1", label: "down" });
    expect(down.id).toBe(up.id); // same row, updated in place
    expect(down.label).toBe("down");
    const { rows } = await pool.query("SELECT count(*)::int AS n, max(label) AS label FROM copilot_feedback");
    expect(rows[0].n).toBe(1);
    expect(rows[0].label).toBe("down");
  });

  it("distinct turns are distinct rows", async () => {
    await repo.recordAskFeedback("t1", { turnId: "turn-1", label: "up" });
    await repo.recordAskFeedback("t1", { turnId: "turn-2", label: "down" });
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM copilot_feedback WHERE trace_id='t1'");
    expect(rows[0].n).toBe(2);
  });

  it("is workspace-scoped — the same (trace,turn) in two tenants are two rows (no cross-tenant upsert)", async () => {
    await repo.recordAskFeedback("t1", { turnId: "turn-1", label: "up" }, "ws-A");
    await repo.recordAskFeedback("t1", { turnId: "turn-1", label: "down" }, "ws-B");
    const a = await pool.query("SELECT label FROM copilot_feedback WHERE workspace_id='ws-A'");
    const b = await pool.query("SELECT label FROM copilot_feedback WHERE workspace_id='ws-B'");
    expect(a.rows[0].label).toBe("up"); // ws-A untouched by ws-B's vote
    expect(b.rows[0].label).toBe("down");
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM copilot_feedback");
    expect(rows[0].n).toBe(2);
  });

  it("seeds a trace so the route-layer trace-existence check has a target (sanity)", async () => {
    await repo.save([span({ spanId: "r1", traceId: "t-real" })]);
    const rec = await repo.recordAskFeedback("t-real", { turnId: "turn-1", label: "up" });
    expect(rec.traceId).toBe("t-real");
  });

  it("deleteAskFeedback retracts the vote (clear), idempotent + workspace-scoped", async () => {
    await repo.recordAskFeedback("t1", { turnId: "turn-1", label: "up" }, "ws-A");
    await repo.recordAskFeedback("t1", { turnId: "turn-1", label: "down" }, "ws-B");
    // ws-A clears its vote → its row is gone; ws-B's is untouched (isolation)
    expect(await repo.deleteAskFeedback("t1", "turn-1", "ws-A")).toBe(true);
    const a = await pool.query("SELECT count(*)::int AS n FROM copilot_feedback WHERE workspace_id='ws-A'");
    const b = await pool.query("SELECT count(*)::int AS n FROM copilot_feedback WHERE workspace_id='ws-B'");
    expect(a.rows[0].n).toBe(0);
    expect(b.rows[0].n).toBe(1); // ws-B's vote survives ws-A's clear
    // idempotent: clearing again is a no-op false, not an error
    expect(await repo.deleteAskFeedback("t1", "turn-1", "ws-A")).toBe(false);
  });

  it("the label CHECK constraint rejects an out-of-domain label (defense-in-depth)", async () => {
    await expect(
      pool.query("INSERT INTO copilot_feedback (workspace_id, trace_id, turn_id, label) VALUES ('ws-A','t1','turn-1','maybe')"),
    ).rejects.toThrow(/copilot_feedback_label_ck|check constraint/i);
  });
});
