/**
 * M140 T4.1/T4.2/T4.3 — the three properties that cannot be proven by inspection.
 *
 * All three share a failure shape: they produce a PLAUSIBLE NUMBER when broken, not an error.
 *   - cross-tenant leak → someone else's usage silently folded into your report;
 *   - dropped un-attributed spans → "nobody consumed this" reads the same as "we don't know who";
 *   - unreported price gap → a total that is quietly low.
 * A reviewer cannot spot any of them by reading the SQL, which is why they are integration tests
 * against a real Postgres rather than unit tests over a mocked driver.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import type pg from "pg";

import type { Span } from "../../../domain/observability/span.js";
import { DEFAULT_PRICES } from "../../../domain/observability/default-prices.js";
import {
  MAX_WINDOW_DAYS,
  usageByUserResponseSchema,
} from "../../../domain/observability/usage-by-user.js";
import { resolveModelPrice } from "../../../domain/observability/pricing.js";
import { createPool, DrizzleSpanRepository } from "./drizzle-span-repository.js";
import { aggregateUsageByUser } from "./usage-by-user-repository.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const suite = PG_URI ? describe : describe.skip;

const WS_A = "ws-usage-a";
const WS_B = "ws-usage-b";

/** A model guaranteed to share NO prefix with any price key (EC-5) — prefix match would false-pass. */
const NO_PRICE_MODEL = "zzz-no-price-model";

function span(over: Partial<Span> & Pick<Span, "spanId" | "traceId">): Span {
  return {
    name: "op",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
    ...over,
  };
}

suite("M140 — usage by end user (integration)", () => {
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
    await db.execute(sql`DELETE FROM spans WHERE workspace_id IN (${WS_A}, ${WS_B})`);
  });

  it("EC-5 guard: the fixture model really has no price", () => {
    // If this ever resolves, the price-gap test below would pass while measuring nothing.
    expect(resolveModelPrice(NO_PRICE_MODEL, DEFAULT_PRICES)).toBeUndefined();
  });

  it("T4.1 — a workspace never sees another workspace's end user", async () => {
    await repo.save(
      [span({ spanId: "a1", traceId: "ta", model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 500, attributes: { "user.id": "alice" } })],
      WS_A,
    );
    await repo.save(
      [span({ spanId: "b1", traceId: "tb", model: "claude-opus-4-8", inputTokens: 7, outputTokens: 3, attributes: { "user.id": "bob" } })],
      WS_B,
    );

    const asB = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_B);

    // (a) alice's identity must not appear …
    expect(asB.users.map((u) => u.userId)).not.toContain("alice");
    // (b) … and her tokens must not be folded into B's totals either. Asserting only (a) would
    // pass on a bug that filtered the label out of the SELECT but not out of the SUM.
    expect(asB.users.reduce((n, u) => n + u.inputTokens, 0)).toBe(7);
    expect(asB.totalUsers).toBe(1);
  });

  it("T4.2 — a span with no identity lands in the unattributed bucket, never dropped", async () => {
    await repo.save(
      [
        span({ spanId: "c1", traceId: "tc", model: "claude-opus-4-8", inputTokens: 10, outputTokens: 1, attributes: { "user.id": "carol" } }),
        span({ spanId: "c2", traceId: "tc", model: "claude-opus-4-8", inputTokens: 20, outputTokens: 2, attributes: { "gen_ai.user.id": "dave" } }),
        span({ spanId: "c3", traceId: "tc", model: "claude-opus-4-8", inputTokens: 30, outputTokens: 3, attributes: { other: "x" } }),
      ],
      WS_A,
    );

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A);
    const ids = r.users.map((u) => u.userId).sort();

    expect(ids).toEqual(["carol", "dave", "unattributed"]);
    // Guard-the-guard: a bug collapsing EVERY user into the bucket would satisfy "unattributed is
    // present". The fallback to gen_ai.user.id must also be exercised — `dave` proves it.
    expect(r.users.find((u) => u.userId === "unattributed")?.inputTokens).toBe(30);
    expect(r.users.find((u) => u.userId === "dave")?.inputTokens).toBe(20);
  });

  it("T4.3a — a priced model produces cost; an unpriced one is reported, not silently free", async () => {
    await repo.save(
      [
        span({ spanId: "d1", traceId: "td", model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 100, attributes: { "user.id": "erin" } }),
        span({ spanId: "d2", traceId: "td", model: NO_PRICE_MODEL, inputTokens: 5000, outputTokens: 500, attributes: { "user.id": "erin" } }),
      ],
      WS_A,
    );

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A);
    const erin = r.users.find((u) => u.userId === "erin");

    expect(r.unpricedSpans).toBe(1);
    // Tokens are counted in full — the gap is in the COST, and the response says so.
    expect(erin?.inputTokens).toBe(6000);
    // Cost reflects only the priced span. Without `unpricedSpans` this reads as the real spend.
    expect(erin?.costUsd).toBeGreaterThan(0);
    const pricedOnly =
      1000 * (resolveModelPrice("claude-opus-4-8", DEFAULT_PRICES)?.inputPerToken ?? 0) +
      100 * (resolveModelPrice("claude-opus-4-8", DEFAULT_PRICES)?.outputPerToken ?? 0);
    expect(erin?.costUsd).toBeCloseTo(Math.round(pricedOnly * 1e6) / 1e6, 6);
  });

  it("T4.3b — a span with no model AND no tokens is not counted as unpriced", async () => {
    // The case measured in discovery: 36,901 such spans on a real workspace. Counting them would
    // report a gap 36,900× larger than the real one and read as "most of your cost is missing".
    await repo.save(
      [
        span({ spanId: "e1", traceId: "te", attributes: { "user.id": "frank" } }),
        span({ spanId: "e2", traceId: "te", model: "claude-opus-4-8", inputTokens: 10, outputTokens: 1, attributes: { "user.id": "frank" } }),
      ],
      WS_A,
    );

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A);

    expect(r.unpricedSpans).toBe(0);
    expect(r.users.find((u) => u.userId === "frank")?.spans).toBe(2);
  });


  it("F-test-1 — an empty or blank user.id lands in the bucket, never 500s the report", async () => {
    // The identity is CLIENT-CHOSEN. `coalesce` only substitutes NULL, so an empty string used to
    // survive into a response the route validates with `.parse()` (userId min(1)) — one malformed
    // attribute from any SDK client answered 500 for that client's whole workspace and window.
    await repo.save(
      [
        span({ spanId: "g1", traceId: "tg", model: "claude-opus-4-8", inputTokens: 11, outputTokens: 0, attributes: { "user.id": "" } }),
        span({ spanId: "g2", traceId: "tg", model: "claude-opus-4-8", inputTokens: 22, outputTokens: 0, attributes: { "user.id": "   " } }),
        span({ spanId: "g3", traceId: "tg", model: "claude-opus-4-8", inputTokens: 33, outputTokens: 0, attributes: { "user.id": "real" } }),
      ],
      WS_A,
    );

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A);

    expect(r.users.map((u) => u.userId).sort()).toEqual(["real", "unattributed"]);
    expect(r.users.find((u) => u.userId === "unattributed")?.inputTokens).toBe(33);
    // The whole point: the response must satisfy the contract the route enforces on the way out.
    expect(() => usageByUserResponseSchema.parse(r)).not.toThrow();
  });

  it("F-test-4 — totalUsers counts distinct users, not spans", async () => {
    // Every earlier fixture gave each user exactly one span, so count() and count(DISTINCT) agreed
    // and the mutation survived. One user with two spans is all it takes to tell them apart.
    await repo.save(
      [
        span({ spanId: "h1", traceId: "th", model: "claude-opus-4-8", inputTokens: 1, outputTokens: 0, attributes: { "user.id": "multi" } }),
        span({ spanId: "h2", traceId: "th", model: "claude-opus-4-8", inputTokens: 1, outputTokens: 0, attributes: { "user.id": "multi" } }),
        span({ spanId: "h3", traceId: "th", model: "claude-opus-4-8", inputTokens: 1, outputTokens: 0, attributes: { "user.id": "solo" } }),
      ],
      WS_A,
    );

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A);

    expect(r.totalUsers).toBe(2);
    expect(r.users.find((u) => u.userId === "multi")?.spans).toBe(2);
  });

  it("F-test-5a — the biggest consumer comes first (behaviour, not source text)", async () => {
    await repo.save(
      [
        span({ spanId: "i1", traceId: "ti", model: "claude-opus-4-8", inputTokens: 10, outputTokens: 0, attributes: { "user.id": "small" } }),
        span({ spanId: "i2", traceId: "ti", model: "claude-opus-4-8", inputTokens: 9000, outputTokens: 0, attributes: { "user.id": "big" } }),
      ],
      WS_A,
    );

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A);
    expect(r.users[0]?.userId).toBe("big");
  });

  it("F-test-5b — user.id wins over gen_ai.user.id when a span carries both", async () => {
    // The fallback ORDER is the rule (M131). No earlier fixture sent both keys, so inverting the
    // coalesce was invisible to behaviour and only the source-string assertion noticed.
    await repo.save(
      [span({ spanId: "j1", traceId: "tj", model: "claude-opus-4-8", inputTokens: 5, outputTokens: 0,
              attributes: { "user.id": "primary", "gen_ai.user.id": "secondary" } })],
      WS_A,
    );

    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A);
    expect(r.users.map((u) => u.userId)).toEqual(["primary"]);
  });

  it("F-test-6 — limit is APPLIED, and offset floors at zero", async () => {
    // Rewritten 2026-08-01 after asking "is there a wrong implementation that would pass this?".
    // The previous version seeded ONE user and asserted `users.length <= MAX_LIMIT`. With one row
    // that is true whether the clamp exists or not — measured: deleting `Math.min(MAX_LIMIT, …)`
    // left all 14 tests green. A fixture with no discriminating power protects the appearance of
    // the behaviour, not the behaviour.
    //
    // Three users and `limit: 2` tells the two implementations apart: applied → 2 rows,
    // ignored → 3.
    await repo.save(
      [
        span({ spanId: "l1", traceId: "tl", model: "claude-opus-4-8", inputTokens: 300, outputTokens: 0, attributes: { "user.id": "lim-a" } }),
        span({ spanId: "l2", traceId: "tl", model: "claude-opus-4-8", inputTokens: 200, outputTokens: 0, attributes: { "user.id": "lim-b" } }),
        span({ spanId: "l3", traceId: "tl", model: "claude-opus-4-8", inputTokens: 100, outputTokens: 0, attributes: { "user.id": "lim-c" } }),
      ],
      WS_A,
    );

    const page = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A, { limit: 2 });
    expect(page.users.map((u) => u.userId)).toEqual(["lim-a", "lim-b"]);
    expect(page.totalUsers).toBe(3);

    // A negative offset must behave as 0 — not error, and not silently skip the first page.
    const negative = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A, { offset: -5 });
    expect(negative.users.map((u) => u.userId)).toEqual(["lim-a", "lim-b", "lim-c"]);

    // HONEST LIMIT: the 500 ceiling itself is NOT exercised — discriminating it needs 501+ seeded
    // users, which is disproportionate here. Since `8e77635` the route rejects `limit > 500` with
    // 400 before the repository is reached (`usage-by-user-route.integration.test.ts` covers that),
    // so the clamp below is defence in depth for a direct caller, and it is asserted structurally.
    const src = readFileSync(new URL("./usage-by-user-repository.ts", import.meta.url), "utf8");
    expect(src).toMatch(/Math\.min\(MAX_LIMIT,/);
  });

  it("F-test-8 — query 2 stays restricted to the page (cardinality risk R3)", () => {
    // Behaviourally equivalent by construction — costByUser is keyed by page id, so extra rows are
    // ignored and no output assertion can ever see it. But without the restriction, query 2 fans out
    // to every distinct user in the window: an unbounded-memory regression that ships green.
    // Structural guard, same precedent as the ORDER BY tiebreak below.
    const src = readFileSync(new URL("./usage-by-user-repository.ts", import.meta.url), "utf8");
    expect(src).toMatch(/AND \$\{userId\} IN \$\{ids\}/);
  });

  it("EC-3 — the ORDER BY carries a total tiebreak", () => {
    // MEASURED (mutation M4, 2026-07-29): the behavioural test below SURVIVES removing the
    // tiebreak. With three rows Postgres happens to return a stable order — same heap page, same
    // plan — so the assertion that the pages do not overlap passes on a query that is not actually
    // deterministic. Seeding hundreds of tied users would raise the odds without ever making the
    // proof deterministic, because the guarantee being tested is one Postgres explicitly does NOT
    // give: with no total ORDER BY, LIMIT/OFFSET may return the same row on two pages.
    //
    // So the determinism is pinned STRUCTURALLY, on the property itself, and the behavioural test
    // is kept for what it does prove (the pagination arithmetic). Same shape as T1.1's
    // single-definition test: assert the source property when the runtime cannot expose it.
    const src = readFileSync(new URL("./usage-by-user-repository.ts", import.meta.url), "utf8");
    // Anchor on the SQL line itself (leading whitespace, no `//`) — a loose match would hit the
    // comment above the query that merely mentions ORDER BY, and pass while measuring nothing.
    const orderByLines = src.split("\n").filter((l) => /^\s+ORDER BY /.test(l));
    expect(orderByLines).toHaveLength(1);
    expect(orderByLines[0]).toMatch(/DESC,\s*1 ASC\s*$/);
  });

  it("EC-3 — pagination returns every user exactly once when totals tie", async () => {
    // Equal totals: without the `userId` tiebreak the two pages may return the same user twice.
    await repo.save(
      [
        span({ spanId: "f1", traceId: "tf", model: "claude-opus-4-8", inputTokens: 100, outputTokens: 0, attributes: { "user.id": "tie-a" } }),
        span({ spanId: "f2", traceId: "tf", model: "claude-opus-4-8", inputTokens: 100, outputTokens: 0, attributes: { "user.id": "tie-b" } }),
        span({ spanId: "f3", traceId: "tf", model: "claude-opus-4-8", inputTokens: 100, outputTokens: 0, attributes: { "user.id": "tie-c" } }),
      ],
      WS_A,
    );

    const p1 = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A, { limit: 2, offset: 0 });
    const p2 = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A, { limit: 2, offset: 2 });
    const seen = [...p1.users, ...p2.users].map((u) => u.userId);

    expect(new Set(seen).size).toBe(3);
    expect(seen.sort()).toEqual(["tie-a", "tie-b", "tie-c"]);
    expect(p1.totalUsers).toBe(3);
  });

  it("clamps an absurd window instead of scanning without bound (EC-4)", async () => {
    const r = await aggregateUsageByUser(db, DEFAULT_PRICES, WS_A, { days: 999_999 });
    expect(r.windowDays).toBe(MAX_WINDOW_DAYS);
  });
});
