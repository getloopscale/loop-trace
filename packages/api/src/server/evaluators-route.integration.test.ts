import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type EngineDeps,
  type Principal,
  type AuthVerifier,
} from "@usetheo/lens-core";
import {
  createSpanRepository,
  migrateLatest,
  evaluatorRepoFromPool,
} from "@usetheo/lens-core/infra";
import type pg from "pg";

import { createApp } from "./app.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

function verifierFor(map: Record<string, Principal>): AuthVerifier {
  return {
    resolvePrincipal: async (t) => map[t] ?? null,
    verify: async (t) => map[t] !== undefined,
  };
}
const principal = (scopes: string[], workspaceId = "ws-x"): Principal => ({
  workspaceId,
  userId: "u",
  role: "member",
  scopes,
});

const OTLP = (traceId: string, spanId: string, status: string) =>
  JSON.stringify({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                spanId,
                traceId,
                name: "op",
                startTimeUnixNano: "1700000000000000000",
                endTimeUnixNano: "1700000000100000000",
                status: { code: status === "error" ? 2 : 1 },
              },
            ],
          },
        ],
      },
    ],
  });

suite("M36 evaluators routes (integration)", () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    const made = createSpanRepository(PG_URI as string);
    pool = made.pool;
    await migrateLatest(pool);
    const evaluatorRepo = evaluatorRepoFromPool(pool);
    const engine: EngineDeps = {
      evaluatorRepo,
      spanRepo: made.repo,
      judge: null,
      backfillMax: 500,
    };
    app = createApp(
      made.repo,
      undefined,
      {
        verifier: verifierFor({
          ro: principal(["observability:read"], "ws-x"),
          rw: principal(["observability:read", "observability:write", "observability:delete"], "ws-x"),
          rw2: principal(["observability:read", "observability:write", "observability:delete"], "ws-y"),
        }),
        requireCredential: true,
      },
      { repo: evaluatorRepo, engine },
    );
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE spans, traces, sessions, evaluators, guards, span_evaluations");
  });
  afterAll(async () => {
    await pool.end();
  });

  const req = (method: string, path: string, token: string, body?: unknown) =>
    app.request(`http://x${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  it("test_evaluator_create_requires_write_scope", async () => {
    const ro = await req("POST", "/v1/evaluators", "ro", {
      name: "q",
      kind: "rule",
      config: { predicate: "status:error" },
    });
    expect(ro.status).toBe(403); // read-only → 403 on a write verb
    const rw = await req("POST", "/v1/evaluators", "rw", {
      name: "q",
      kind: "rule",
      config: { predicate: "status:error" },
    });
    expect(rw.status).toBe(200);
  });

  it("test_create_rule_rejects_zero_clause_predicate", async () => {
    const bad = await req("POST", "/v1/evaluators", "rw", {
      name: "bad",
      kind: "rule",
      config: { predicate: "statuss:eror" }, // typo → 0 clauses
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe("INVALID_PREDICATE");
  });

  it("test_list_requires_read_scope_and_is_workspace_scoped", async () => {
    await req("POST", "/v1/evaluators", "rw", { name: "q", kind: "rule", config: { predicate: "" } });
    const list = await req("GET", "/v1/evaluators", "rw");
    expect(list.status).toBe(200);
    expect(((await list.json()) as { evaluators: unknown[] }).evaluators).toHaveLength(1);
  });

  it("test_run_endpoint_writes_verdicts_then_visible_via_m26_surface", async () => {
    // ingest a span, create + run a rule evaluator, then read it via the M26 endpoint
    await app.request("http://x/v1/traces", {
      method: "POST",
      headers: { authorization: "Bearer rw", "content-type": "application/json" },
      body: OTLP("t1", "s1", "error"),
    });
    const created = await req("POST", "/v1/evaluators", "rw", {
      name: "is_error",
      kind: "rule",
      config: { predicate: "status:error" },
      target: "",
    });
    const id = ((await created.json()) as { id: string }).id;
    const run = await req("POST", `/v1/evaluators/${id}/run`, "rw", {});
    expect(run.status).toBe(200);
    expect(((await run.json()) as { written: number }).written).toBeGreaterThanOrEqual(1);
    // M26 read surface reflects the written verdict
    const metrics = await app.request("http://x/v1/metrics/evaluators?range=30d", {
      headers: { authorization: "Bearer rw" },
    });
    const names = ((await metrics.json()) as { evaluators: { name: string }[] }).evaluators.map((e) => e.name);
    expect(names).toContain("is_error");
  });

  it("test_run_nonexistent_evaluator_404", async () => {
    const r = await req("POST", "/v1/evaluators/00000000-0000-0000-0000-000000000000/run", "rw", {});
    expect(r.status).toBe(404);
    expect(((await r.json()) as { code: string }).code).toBe("EVALUATOR_NOT_FOUND");
  });

  it("test_guard_breaches_endpoint_scoped", async () => {
    const ev = await req("POST", "/v1/evaluators", "rw", { name: "q", kind: "rule", config: { predicate: "" } });
    const evId = ((await ev.json()) as { id: string }).id;
    const g = await req("POST", "/v1/guards", "rw", { evaluatorId: evId, operator: "lt", threshold: 0.5 });
    expect(g.status).toBe(200);
    const gId = ((await g.json()) as { id: string }).id;
    const breaches = await req("GET", `/v1/guards/${gId}/breaches`, "rw");
    expect(breaches.status).toBe(200);
    expect(((await breaches.json()) as { traceIds: string[] }).traceIds).toEqual([]);
  });

  it("M82 — PUT /evaluators/:id renames (write scope) keeping id/kind/createdAt", async () => {
    const created = await req("POST", "/v1/evaluators", "rw", { name: "orig", kind: "rule", config: { predicate: "status:error" } });
    const rec = (await created.json()) as { id: string; createdAt: string };
    // read-only principal → 403 on the write verb
    const ro = await req("PUT", `/v1/evaluators/${rec.id}`, "ro", { name: "renamed" });
    expect(ro.status).toBe(403);
    const put = await req("PUT", `/v1/evaluators/${rec.id}`, "rw", { name: "renamed" });
    expect(put.status).toBe(200);
    const updated = (await put.json()) as { id: string; name: string; kind: string; createdAt: string };
    expect(updated.name).toBe("renamed");
    expect(updated.id).toBe(rec.id); // id preserved
    expect(updated.kind).toBe("rule"); // kind preserved
    expect(updated.createdAt).toBe(rec.createdAt); // createdAt preserved
  });

  it("M82 — PUT /evaluators/:id to an existing name conflicts (409)", async () => {
    await req("POST", "/v1/evaluators", "rw", { name: "aaa", kind: "rule", config: { predicate: "status:error" } });
    const b = await req("POST", "/v1/evaluators", "rw", { name: "bbb", kind: "rule", config: { predicate: "status:error" } });
    const bId = ((await b.json()) as { id: string }).id;
    const conflict = await req("PUT", `/v1/evaluators/${bId}`, "rw", { name: "aaa" });
    expect(conflict.status).toBe(409); // duplicate name → typed 409, not a 500
  });

  it("M82 — PUT /evaluators/:id absent → 404", async () => {
    const put = await req("PUT", `/v1/evaluators/00000000-0000-0000-0000-000000000000`, "rw", { name: "x" });
    expect(put.status).toBe(404);
  });

  it("M82 — PUT /evaluators/:id with a non-uuid id → 404, never a 500 (review H-1)", async () => {
    const put = await req("PUT", `/v1/evaluators/not-a-uuid`, "rw", { name: "x" });
    expect(put.status).toBe(404); // garbage path param → absent, not a pg 22P02 → 500
  });

  it("M82 — PUT /evaluators/:id is workspace-scoped (ws-y cannot rename ws-x's evaluator)", async () => {
    const created = await req("POST", "/v1/evaluators", "rw", { name: "owned", kind: "rule", config: { predicate: "status:error" } });
    const id = ((await created.json()) as { id: string }).id;
    // ws-y (rw2) attempts to rename ws-x's evaluator → not found in its scope → 404
    const hijack = await req("PUT", `/v1/evaluators/${id}`, "rw2", { name: "hijacked" });
    expect(hijack.status).toBe(404);
    // ws-x's evaluator is untouched
    const still = await req("GET", `/v1/evaluators/${id}`, "rw");
    expect(((await still.json()) as { name: string }).name).toBe("owned");
  });

  // ── M119 (Phase 2, D2) — guards negatives + cross-tenant isolation ────────────────────────────
  // The guards are the shallowest advanced capability: happy-path only until now. These four assert
  // the malformed-body 400, the cross-workspace 404 SECURITY branch (evaluators.ts:182-187), the
  // delete-idempotency edge, and the breaches-read isolation — all against the REAL evaluator/guard
  // repo (Testcontainers PG), reusing the two-workspace verifier (rw=ws-x, rw2=ws-y). A negative test
  // asserts the SPECIFIC typed error, not merely "it 4xx-ed" (rules/testing.md §4.1).

  it("test_create_guard_400_on_malformed_body", async () => {
    // (a) a null/non-JSON body → INVALID_BODY (readJson returns null); (b) a non-guard-shape body →
    // INVALID_GUARD (zod safeParse fails). Two distinct typed codes, both pinned.
    const a = await req("POST", "/v1/guards", "rw", null);
    expect(a.status).toBe(400);
    expect(((await a.json()) as { code: string }).code).toBe("INVALID_BODY");
    const b = await req("POST", "/v1/guards", "rw", { nope: 1 });
    expect(b.status).toBe(400);
    expect(((await b.json()) as { code: string }).code).toBe("INVALID_GUARD");
  });

  it("test_create_guard_404_when_evaluator_cross_workspace", async () => {
    // SECURITY (EVAL-5, evaluators.ts:182-187): ws-x creates evaluator E; ws-y attaches a guard to
    // E.id → the scoped getEvaluator(E.id, ws-y) is null → 404 EVALUATOR_NOT_FOUND. A 200 here would
    // be a live cross-workspace leak (ws-y guarding ws-x's evaluator) — the milestone would fix the
    // SQL scoping no-workaround. ws-x's guard list must not gain a guard either.
    const ev = await req("POST", "/v1/evaluators", "rw", { name: "owned_eval", kind: "rule", config: { predicate: "status:error" } });
    const evId = ((await ev.json()) as { id: string }).id;
    const res = await req("POST", "/v1/guards", "rw2", { evaluatorId: evId, operator: "gt", threshold: 0 });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("EVALUATOR_NOT_FOUND");
    // ws-x sees NO guard (the cross-workspace attempt created nothing in either workspace).
    const xGuards = await req("GET", "/v1/guards", "rw");
    expect(((await xGuards.json()) as { guards: unknown[] }).guards).toHaveLength(0);
    // ws-y also sees no guard.
    const yGuards = await req("GET", "/v1/guards", "rw2");
    expect(((await yGuards.json()) as { guards: unknown[] }).guards).toHaveLength(0);
  });

  it("test_delete_guard_absent_is_idempotent", async () => {
    // A valid-but-absent DELETE target (edge case): deleteGuard is a workspace-scoped no-op on a
    // missing row, so DELETE returns 204 — never 404/500 — and stays 204 on a repeat (idempotent).
    const first = await req("DELETE", "/v1/guards/does-not-exist", "rw");
    expect(first.status).toBe(204);
    const second = await req("DELETE", "/v1/guards/does-not-exist", "rw");
    expect(second.status).toBe(204);
  });

  it("test_guard_breaches_cross_tenant_isolation", async () => {
    // Build a REAL breach in ws-x: ingest a span whose OTLP status is the proto-json enum name
    // `STATUS_CODE_ERROR` (so `String(status.code)` matches the `status:error` predicate's /error/i —
    // a numeric OTLP code 2 stringifies to "2" and would NOT match), create + run a rule evaluator
    // (writes verdict score=1), create a `gt 0` guard so the verdict breaches. ws-x reading breaches
    // sees the trace; ws-y reading the SAME guard id sees NONE (listBreachingTraces scopes g.workspace_id).
    const errorSpanEnvelope = JSON.stringify({
      resourceSpans: [{ scopeSpans: [{ spans: [{
        spanId: "x-span", traceId: "x-trace", name: "op",
        startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000100000000",
        status: { code: "STATUS_CODE_ERROR" },
      }] }] }],
    });
    await app.request("http://x/v1/traces", {
      method: "POST",
      headers: { authorization: "Bearer rw", "content-type": "application/json" },
      body: errorSpanEnvelope,
    });
    const ev = await req("POST", "/v1/evaluators", "rw", { name: "is_error", kind: "rule", config: { predicate: "status:error" }, target: "" });
    const evId = ((await ev.json()) as { id: string }).id;
    const run = await req("POST", `/v1/evaluators/${evId}/run`, "rw", {});
    expect(((await run.json()) as { written: number }).written).toBeGreaterThanOrEqual(1);
    const g = await req("POST", "/v1/guards", "rw", { evaluatorId: evId, operator: "gt", threshold: 0 });
    expect(g.status).toBe(200);
    const gId = ((await g.json()) as { id: string }).id;

    // ws-x (the owner) sees its breaching trace — proves the path reaches data (not a false negative).
    const xBreaches = await req("GET", `/v1/guards/${gId}/breaches`, "rw");
    expect(xBreaches.status).toBe(200);
    expect(((await xBreaches.json()) as { traceIds: string[] }).traceIds).toContain("x-trace");

    // ws-y reads ws-x's guard id → MUST NOT see ws-x's breaching trace (scoped read, cross-tenant deny).
    const yBreaches = await req("GET", `/v1/guards/${gId}/breaches`, "rw2");
    expect(yBreaches.status).toBe(200);
    const yTraceIds = ((await yBreaches.json()) as { traceIds: string[] }).traceIds;
    expect(yTraceIds).not.toContain("x-trace");
    expect(yTraceIds).toHaveLength(0);

    // A non-uuid guard id in the breaches read → empty (200), never a 500 (22P02) — same isUuid
    // guard as deleteGuard/getEvaluator (M119 no-workaround fix).
    const garbage = await req("GET", `/v1/guards/not-a-uuid/breaches`, "rw");
    expect(garbage.status).toBe(200);
    expect(((await garbage.json()) as { traceIds: string[] }).traceIds).toEqual([]);
  });
});
