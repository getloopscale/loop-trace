import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type EngineDeps,
  type Principal,
  type AuthVerifier, EvaluatorRunJobRegistry,} from "@usetheo/lens-core";
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
      { repo: evaluatorRepo, engine, runJobs: new EvaluatorRunJobRegistry() },
    );
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE spans, traces, sessions, evaluators, monitors, span_evaluations");
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
    // M133 made this endpoint asynchronous: it accepts with 202 and a job the
    // caller polls. This assertion carried the pre-M133 synchronous contract and
    // was not updated -- it could not fail, because a missing subpath alias in
    // vitest.integration.config.ts meant this whole file never loaded.
    const run = await req("POST", `/v1/evaluators/${id}/run`, "rw", {});
    expect(run.status).toBe(202);
    const job = (await run.json()) as { id: string; status: string };
    expect(job.status).toBe("queued");

    const done = await pollRunJob(job.id);
    expect(done.status).toBe("completed");
    expect(done.scored).toBeGreaterThanOrEqual(1);
    // M26 read surface reflects the written verdict
    const metrics = await app.request("http://x/v1/metrics/evaluators?range=30d", {
      headers: { authorization: "Bearer rw" },
    });
    const names = ((await metrics.json()) as { evaluators: { name: string }[] }).evaluators.map((e) => e.name);
    expect(names).toContain("is_error");
  });

  /** Poll an M133 run job to a terminal state. Bounded so a hang fails loudly. */
  async function pollRunJob(
    jobId: string,
  ): Promise<{ status: string; scored: number }> {
    for (let i = 0; i < 100; i += 1) {
      const r = await app.request(`http://x/v1/evaluator-run-jobs/${jobId}`, {
        headers: { authorization: "Bearer rw" },
      });
      const body = (await r.json()) as { status: string; scored: number };
      if (body.status === "completed" || body.status === "failed") return body;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error(`run job ${jobId} never reached a terminal state`);
  }

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

  // ── M135 T3.0 — the windowed carrier over HTTP ───────────────────────────────────────────────
  // theo-cloud's evaluator reads THIS, not the observability series. The series is a workspace
  // aggregate returning one float per window; it cannot answer a per-guard question.
  //
  // The window param is VALIDATED rather than defaulted on garbage. Silently coercing an
  // unparseable window into a default reads a different span of time than the caller asked for —
  // the same class of silent coercion as theo-cloud#247, one layer up.

  const makeGuard = async () => {
    const ev = await req("POST", "/v1/evaluators", "rw", { name: "w", kind: "rule", config: { predicate: "" } });
    const evId = ((await ev.json()) as { id: string }).id;
    const g = await req("POST", "/v1/guards", "rw", { evaluatorId: evId, operator: "lt", threshold: 0.5 });
    return ((await g.json()) as { id: string }).id;
  };

  it("test_breach_window_reports_absence_when_nothing_was_evaluated", async () => {
    const gId = await makeGuard();
    const res = await req("GET", `/v1/guards/${gId}/breach-window?window=3600`, "rw");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hasData: boolean; breachCount: number; evaluatedCount: number };
    // The load-bearing assertion: an empty window is ABSENCE, not a zero. A caller that reads
    // only breachCount here would see 0 and fire every lt/lte rule — which is exactly #247.
    expect(body.hasData).toBe(false);
    expect(body.breachCount).toBe(0);
    expect(body.evaluatedCount).toBe(0);
  });

  // ── The wire contract theo-cloud decodes ─────────────────────────────────────────────────────
  //
  // theo-cloud's alert evaluator unmarshals this body into a struct and branches on `guardExists`
  // to decide whether a rule's guard has been deleted. That consumer lives in another repository,
  // so nothing here would break if a field were renamed or dropped — which is precisely how the
  // first version shipped: theo-cloud branched on a 404 this route never emits, and both sides'
  // tests passed because each was written against its own author's intent.
  //
  // This asserts the exact key set on the wire. Dropping or renaming a key fails HERE, in the repo
  // that owns the contract, instead of silently in a consumer nobody runs in this suite.
  it("test_breach_window_wire_contract_is_the_shape_theo_cloud_decodes", async () => {
    const gId = await makeGuard();
    const res = await req("GET", `/v1/guards/${gId}/breach-window?window=3600`, "rw");
    const body = (await res.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(
      ["breachCount", "evaluatedCount", "guardExists", "hasData", "windowSeconds"].sort(),
    );
    expect(typeof body["guardExists"]).toBe("boolean");
    expect(typeof body["hasData"]).toBe("boolean");
    expect(typeof body["breachCount"]).toBe("number");
    expect(typeof body["evaluatedCount"]).toBe("number");
    // A REAL guard with an empty window: present, but nothing to evaluate. The pair that the first
    // version could not express, asserted on the wire rather than in the repository layer.
    expect(body["guardExists"]).toBe(true);
    expect(body["hasData"]).toBe(false);
  });

  it("test_breach_window_rejects_an_unparseable_window", async () => {
    const gId = await makeGuard();
    for (const w of ["abc", "-1", "0", ""]) {
      const res = await req("GET", `/v1/guards/${gId}/breach-window?window=${w}`, "rw");
      expect(res.status).toBe(400);
    }
  });

  it("test_breach_window_does_not_leak_across_workspaces", async () => {
    // The guard belongs to ws-x. ws-y asking about it gets ABSENCE — not a 404 that confirms the
    // id exists, and not another tenant's counts.
    const gId = await makeGuard();
    const res = await req("GET", `/v1/guards/${gId}/breach-window?window=60`, "rw2");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { hasData: boolean }).hasData).toBe(false);
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
    // A valid-but-absent DELETE target (edge case): deleteMonitor is a workspace-scoped no-op on a
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
    // M133 async contract — the verdict this test depends on only exists once
    // the job completes, so the poll is load-bearing, not ceremony.
    const run = await req("POST", `/v1/evaluators/${evId}/run`, "rw", {});
    expect(run.status).toBe(202);
    const done = await pollRunJob(((await run.json()) as { id: string }).id);
    expect(done.status).toBe("completed");
    expect(done.scored).toBeGreaterThanOrEqual(1);
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
    // guard as deleteMonitor/getEvaluator (M119 no-workaround fix).
    const garbage = await req("GET", `/v1/guards/not-a-uuid/breaches`, "rw");
    expect(garbage.status).toBe(200);
    expect(((await garbage.json()) as { traceIds: string[] }).traceIds).toEqual([]);
  });
});
