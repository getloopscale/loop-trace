/**
 * M140 — the endpoint exercised through the path the PRODUCT actually uses.
 *
 * Why this file exists (measured 2026-07-29, review mutation round): every other M140 test calls
 * the free function `aggregateUsageByUser(db, priceTable, workspaceId, opts)` directly. Two
 * cross-tenant leaks survived the whole suite because of it:
 *
 *   M16 — the facade discarding the caller's workspaceId and passing DEFAULT_WORKSPACE_ID:
 *         every tenant would read the default workspace. 22 tests green.
 *   M17 — the route honouring `?workspaceId=`, the exact leak its own comment forbids. 22 green.
 *
 * The facade takes `(opts, workspaceId)` while the free function takes
 * `(db, priceTable, workspaceId, opts)`, so a parameter-order slip ships green and every tenant
 * reads someone else's data. Tenant isolation is an inviolable invariant of this capability, and a
 * leak here surfaces as a plausible number rather than an error — the failure mode this whole
 * milestone was built against. The unit of proof has to be the boundary, not the helper.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";

import type { AuthVerifier, Principal } from "@usetheo/lens-core";
import { createSpanRepository, migrateLatest } from "@usetheo/lens-core/infra";
import { createApp } from "./app.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

const principal = (scopes: string[], workspaceId: string): Principal => ({
  workspaceId,
  userId: "u",
  role: "member",
  scopes,
});

function verifierFor(map: Record<string, Principal>): AuthVerifier {
  return {
    resolvePrincipal: async (t) => map[t] ?? null,
    verify: async (t) => map[t] !== undefined,
  };
}

const span = (over: Record<string, unknown>) => ({
  name: "op",
  startTimeUnixNano: "1700000000000000000",
  endTimeUnixNano: "1700000000100000000",
  ...over,
});

suite("M140 — usage-by-user through the real route", () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    const made = createSpanRepository(PG_URI as string);
    pool = made.pool;
    await migrateLatest(pool);
    app = createApp(made.repo, undefined, {
      verifier: verifierFor({
        // Two tenants, and one key with no read scope — the three principals the assertions need.
        a: principal(["observability:read"], "ws-a"),
        b: principal(["observability:read"], "ws-b"),
        noscope: principal(["observability:write"], "ws-a"),
      }),
      requireCredential: true,
    });
    await made.repo.save(
      [
        span({ spanId: "ra1", traceId: "tra", model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 500, attributes: { "user.id": "alice" } }),
      ] as never,
      "ws-a",
    );
    await made.repo.save(
      [
        span({ spanId: "rb1", traceId: "trb", model: "claude-opus-4-8", inputTokens: 7, outputTokens: 3, attributes: { "user.id": "bob" } }),
      ] as never,
      "ws-b",
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  const get = (path: string, token: string) =>
    app.request(`http://x${path}`, { headers: { authorization: `Bearer ${token}` } });

  it("answers 200 with the documented shape", async () => {
    const res = await get("/v1/analytics/usage-by-user?days=30", "b");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["windowDays"]).toBe(30);
    expect(body).toHaveProperty("unpricedSpans");
    expect(body).toHaveProperty("totalUsers");
  });

  it("KILLS M16/M17 — workspace B never sees workspace A's end user, through the real stack", async () => {
    const res = await get("/v1/analytics/usage-by-user", "b");
    const body = (await res.json()) as { users: { userId: string; inputTokens: number }[]; totalUsers: number };

    expect(body.users.map((u) => u.userId)).not.toContain("alice");
    // …and the tokens must not be folded in either: asserting only the label passes on a bug that
    // filters the id out of the SELECT but not out of the SUM.
    expect(body.users.reduce((n, u) => n + u.inputTokens, 0)).toBe(7);
    expect(body.totalUsers).toBe(1);
  });

  it("ignores ?workspaceId= — the workspace comes from the Principal, never from the caller", async () => {
    // The explicit leak attempt. If the route ever honours this parameter, B reads A's report.
    const res = await get("/v1/analytics/usage-by-user?workspaceId=ws-a", "b");
    const body = (await res.json()) as { users: { userId: string }[] };
    expect(body.users.map((u) => u.userId)).not.toContain("alice");
  });

  it("requires observability:read", async () => {
    expect((await get("/v1/analytics/usage-by-user", "noscope")).status).toBe(403);
  });

  it("rejects an unknown credential", async () => {
    expect((await get("/v1/analytics/usage-by-user", "nobody")).status).toBe(401);
  });

  it("KILLS M8b — every invalid query param fails fast with a typed error", async () => {
    // The whole validation block could be deleted and every suite stayed green: nothing reached
    // the handler. Assert the CODE too, not just the status (error-handling.md § 2).
    for (const qs of ["?days=abc", "?days=0", "?days=-1", "?limit=abc", "?limit=0", "?offset=-1", "?offset=abc"]) {
      const res = await get(`/v1/analytics/usage-by-user${qs}`, "a");
      expect(res.status, `${qs} must be rejected`).toBe(400);
      expect((await res.json()) as Record<string, unknown>).toMatchObject({ code: "INVALID_QUERY" });
    }
  });

  it("honours a valid window instead of silently defaulting", async () => {
    const body = (await (await get("/v1/analytics/usage-by-user?days=7", "a")).json()) as { windowDays: number };
    expect(body.windowDays).toBe(7);
  });
});
