import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { Span } from "../../domain/observability/span.js";
import { sessionListItemSchema } from "../../domain/observability/session.js";
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

suite("listSessions first-message enrichment (integration, M20 T1.1)", () => {
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

  it("list_sessions_enriches_first_message_preview", async () => {
    // Two traces in S1; the EARLIEST trace's root-span input is the first message.
    await repo.save([
      span({
        spanId: "early",
        traceId: "t-early",
        sessionId: "S1",
        startTimeUnixNano: "1700000000000000000",
        inputValue: "FIRST MESSAGE",
      }),
    ]);
    await repo.save([
      span({
        spanId: "late",
        traceId: "t-late",
        sessionId: "S1",
        startTimeUnixNano: "1700000000500000000",
        inputValue: "SECOND MESSAGE",
      }),
    ]);
    const { sessions } = await repo.listSessions();
    const s1 = sessions.find((s) => s.sessionId === "S1");
    expect(s1).toBeDefined();
    expect(s1!.firstMessagePreview).toBe("FIRST MESSAGE");
    // schema still valid (additive optional field, .strict() preserved)
    expect(() => sessionListItemSchema.parse(s1)).not.toThrow();
  });

  it("list_sessions_first_message_truncated_to_120", async () => {
    const long = "x".repeat(200);
    await repo.save([
      span({ spanId: "a", traceId: "ta", sessionId: "S1", inputValue: long }),
    ]);
    const { sessions } = await repo.listSessions();
    const s1 = sessions.find((s) => s.sessionId === "S1")!;
    expect(s1.firstMessagePreview).toBeDefined();
    // preview() caps at 120 + ellipsis (M18 helper) — never the full 200.
    expect(s1.firstMessagePreview!.length).toBeLessThanOrEqual(121);
  });

  it("list_sessions_first_message_absent_is_omitted", async () => {
    // EC-1: a session whose earliest root span has NULL input, and another with
    // whitespace-only input — both omit firstMessagePreview (no garbage), row valid.
    await repo.save([span({ spanId: "n1", traceId: "t-null", sessionId: "Snull" })]);
    await repo.save([
      span({ spanId: "w1", traceId: "t-ws", sessionId: "Sws", inputValue: "   " }),
    ]);
    const { sessions } = await repo.listSessions();
    const snull = sessions.find((s) => s.sessionId === "Snull")!;
    const sws = sessions.find((s) => s.sessionId === "Sws")!;
    expect(snull.firstMessagePreview).toBeUndefined();
    expect(sws.firstMessagePreview).toBeUndefined();
    expect(() => sessionListItemSchema.parse(snull)).not.toThrow();
    expect(() => sessionListItemSchema.parse(sws)).not.toThrow();
  });

  it("list_sessions_paginates_with_a_workspace_scoped_total (M81)", async () => {
    // three distinct sessions in the default workspace
    for (const i of [1, 2, 3]) {
      await repo.save([span({ spanId: `p${i}`, traceId: `tp${i}`, sessionId: `SP${i}`, inputValue: `q${i}` })]);
    }
    const page1 = await repo.listSessions(undefined, { limit: 2, offset: 0 });
    expect(page1.sessions).toHaveLength(2); // the page is bounded
    expect(page1.total).toBe(3); // total counts SESSIONS, not member traces
    expect(page1.limit).toBe(2);
    expect(page1.offset).toBe(0);
    const page2 = await repo.listSessions(undefined, { limit: 2, offset: 2 });
    expect(page2.sessions).toHaveLength(1); // the remainder
    expect(page2.total).toBe(3); // stable across pages
    // the two pages are disjoint (offset advances the window)
    const p1 = new Set(page1.sessions.map((s) => s.sessionId));
    expect(page2.sessions.every((s) => !p1.has(s.sessionId))).toBe(true);
  });
});
