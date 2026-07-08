import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createSpanRepository,
  migrateLatest,
  evaluatorRepoFromPool,
  type EngineDeps,
  type Principal,
  type AuthVerifier,
} from "@usetheo/lens-core";
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
});
