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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";

import { MAX_OFFSET, type AuthVerifier, type Principal } from "@looptrace/core";
import { createSpanRepository, migrateLatest } from "@looptrace/core/infra";
import { createApp } from "./app.js";
import { usageByUserReports } from "./metrics.js";

const PG_URI = process.env["LOOPTRACE_PG_URI"];
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

// Workspace ids UNIQUE to this file. They used to be "ws-a"/"ws-b", which
// `evaluation/labeling-queue.integration.test.ts` also owns and also seeds spans into — including
// one with no `user.id`, which lands in the `unattributed` bucket and pushes this file's
// `totalUsers` from 1 to 2. MEASURED: the full integration suite went red in 2 of 5 runs on a clean
// database, and only when vitest's duration-based sequencer happened to order that file first. A
// single-file run never reproduces it, and `fileParallelism: false` prevents interleaving, not
// ordering — which is why this survived review until someone ran the whole suite five times.
//
// Two independent fixes, because either alone leaves the trap armed: unique ids so no other file
// can seed into this one's workspaces, AND explicit cleanup so a previous run of THIS file cannot
// double-seed (the config documents a per-file TRUNCATE convention this file never followed).
const WS_A = "ws-usage-route-a";
const WS_B = "ws-usage-route-b";

suite("M140 — usage-by-user through the real route", () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;

  const clearFixtures = async () =>
    pool.query("DELETE FROM spans WHERE workspace_id = ANY($1)", [[WS_A, WS_B]]);

  beforeAll(async () => {
    const made = createSpanRepository(PG_URI as string);
    pool = made.pool;
    await migrateLatest(pool);
    await clearFixtures();
    app = createApp(made.repo, undefined, {
      verifier: verifierFor({
        // Two tenants, and one key with no read scope — the three principals the assertions need.
        a: principal(["observability:read"], WS_A),
        b: principal(["observability:read"], WS_B),
        noscope: principal(["observability:write"], WS_A),
      }),
      requireCredential: true,
    });
    await made.repo.save(
      [
        span({ spanId: "ra1", traceId: "tra", model: "claude-opus-4-8", inputTokens: 1000, outputTokens: 500, attributes: { "user.id": "alice" } }),
      ] as never,
      WS_A,
    );
    await made.repo.save(
      [
        span({ spanId: "rb1", traceId: "trb", model: "claude-opus-4-8", inputTokens: 7, outputTokens: 3, attributes: { "user.id": "bob" } }),
      ] as never,
      WS_B,
    );
  });

  afterAll(async () => {
    await clearFixtures();
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
    const res = await get(`/v1/analytics/usage-by-user?workspaceId=${WS_A}`, "b");
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

  it("rejects an out-of-range window and page size instead of clamping in silence", async () => {
    // Documented in SURFACE-looptrace § 6.3 as the most likely adversarial angle, and it is a real
    // defect: `?limit=100000` answered 200 with at most 500 rows and NOTHING in the response said
    // so. `windowDays` is echoed, `limit` is not — so a caller paging with a large limit advances
    // `offset` by 100000 while receiving 500 rows, and reads the wrong pages with no signal.
    //
    // The route's own comment already promised that "a caller never receives a window different
    // from the one it asked for". Now it is true. Safe to tighten: the route is one day old and has
    // no consumer — it is absent from both the dashboard BFF and the read SDK.
    for (const qs of ["?days=999999", "?limit=100000"]) {
      const res = await get(`/v1/analytics/usage-by-user${qs}`, "a");
      expect(res.status, `${qs} must be rejected, not clamped`).toBe(400);
      expect((await res.json()) as Record<string, unknown>).toMatchObject({ code: "INVALID_QUERY" });
    }
    // The boundary values themselves stay valid — the ceiling is inclusive.
    expect((await get("/v1/analytics/usage-by-user?days=365&limit=500", "a")).status).toBe(200);
  });

  /*
   * M143 — o teto do PRODUTO `limit × days`, e por que ele existe.
   *
   * MEDIDO (blueprint do M143, Postgres 17, perfil denso): `limit=50&days=365&bucket=day` produz
   * 18.250 pontos e **1.591 kB** de JSON para uma tela. O uso real do gráfico (top-5 × 365) são
   * 1.825 pontos / 101 kB / 18,9 ms.
   *
   * O tempo cresce 1,73× com o bucket; o RESULTADO cresce 365×. Um teto só em `days` ou só em
   * `limit` não limita o que explode — 50 × 365 passa por qualquer teto individual razoável.
   */
  it("M143 — recusa o produto limit × days acima do teto, nomeando OS DOIS parametros", async () => {
    const res = await get("/v1/analytics/usage-by-user?limit=50&days=365&bucket=day", "a");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("INVALID_QUERY");
    // Nomear só um dos dois deixa o chamador girando o botão errado.
    expect(body.message).toMatch(/limit/i);
    expect(body.message).toMatch(/days/i);
    expect(body.message).toMatch(/2000/);
  });

  // F-4 do review: os dois casos de teto passavam AMBOS os parâmetros, então o ramo que substitui
  // o default nunca era exercitado — e é justamente a forma que estoura o payload sem ninguém pedir
  // um número grande. Medido: `?days=365&bucket=day` são 365 × 50 = 18.250 pontos.
  it("M143 — o teto conta o default de limit quando ele e omitido", async () => {
    const res = await get("/v1/analytics/usage-by-user?days=365&bucket=day", "a");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/18300/);
  });

  // F-5 do review: "no máximo 2000" e "menos que 2000" eram indistinguíveis para a suíte.
  it("M143 — a fronteira do teto e INCLUSIVA", async () => {
    // (4 + 1) × 400 = 2000, exatamente no teto. O `+1` é o dia extra que uma janela rolante
    // atravessa — medido no review: `days=3` produz 4 baldes.
    expect((await get("/v1/analytics/usage-by-user?days=4&limit=400&bucket=day", "a")).status).toBe(200);
    // e um ponto acima já recusa
    expect((await get("/v1/analytics/usage-by-user?days=4&limit=401&bucket=day", "a")).status).toBe(400);
  });

  it("M143 — aceita o uso real do grafico (top-5 x 365 dias)", async () => {
    expect((await get("/v1/analytics/usage-by-user?limit=5&days=365&bucket=day", "a")).status).toBe(200);
  });

  // O teto é do produto QUANDO HÁ SÉRIE. Aplicá-lo sempre quebraria a tabela que a M142 já usa em
  // produção — `limit=50&days=365` sem bucket é uma consulta legítima que responde 200 hoje.
  it("M143 — o teto NAO se aplica sem bucket", async () => {
    expect((await get("/v1/analytics/usage-by-user?limit=50&days=365", "a")).status).toBe(200);
  });

  it("M143 — recusa um bucket desconhecido em vez de cair no default em silencio", async () => {
    for (const qs of ["?bucket=week", "?bucket=", "?bucket=1"]) {
      const res = await get(`/v1/analytics/usage-by-user${qs}`, "a");
      expect(res.status, `${qs} deve ser recusado`).toBe(400);
      expect((await res.json()) as Record<string, unknown>).toMatchObject({ code: "INVALID_QUERY" });
    }
  });

  it("M143 — com bucket=day a resposta carrega series; sem ele, nao", async () => {
    const com = (await (await get("/v1/analytics/usage-by-user?bucket=day", "a")).json()) as { users: { series?: unknown[] }[] };
    const sem = (await (await get("/v1/analytics/usage-by-user", "a")).json()) as { users: { series?: unknown[] }[] };
    expect(Array.isArray(com.users[0]?.series)).toBe(true);
    expect(sem.users[0]?.series).toBeUndefined();
  });

  it("honours a valid window instead of silently defaulting", async () => {
    const body = (await (await get("/v1/analytics/usage-by-user?days=7", "a")).json()) as { windowDays: number };
    expect(body.windowDays).toBe(7);
  });

  it("rejects an offset above the ceiling instead of answering 500 from the driver", async () => {
    // `offset` was the one parameter with a shape check and no magnitude check. These two values
    // are integers by `Number.isInteger` and are NOT representable as bigint, so they used to sail
    // past validation and die in the driver as `invalid input syntax for type bigint` — surfacing
    // as a generic 500 where this route's own contract promises a typed 400.
    for (const qs of [`?offset=${MAX_OFFSET + 1}`, "?offset=1e21", "?offset=99999999999999999999"]) {
      const res = await get(`/v1/analytics/usage-by-user${qs}`, "a");
      expect(res.status, `${qs} must be rejected with a typed error`).toBe(400);
      expect((await res.json()) as Record<string, unknown>).toMatchObject({ code: "INVALID_QUERY" });
    }
    // The ceiling itself stays valid — inclusive, like days/limit.
    expect((await get(`/v1/analytics/usage-by-user?offset=${MAX_OFFSET}`, "a")).status).toBe(200);
  });

  it("counts every served report — the wiring triad's runtime pillar", async () => {
    // Without this the feature is invisible in production: when it breaks or gets hammered, no
    // counter moves. Asserting the DELTA rather than the absolute keeps it independent of test order.
    const before = usageByUserReports.value;
    await get("/v1/analytics/usage-by-user", "a");
    expect(usageByUserReports.value).toBe(before + 1);
    // …and a REJECTED request must not count as a served report.
    await get("/v1/analytics/usage-by-user?days=abc", "a");
    expect(usageByUserReports.value).toBe(before + 1);
  });

  it("marks the response private and uncacheable", async () => {
    // The body is a list of client-chosen identities that may be PII (risk R1), and M141 puts a
    // proxy in front of it.
    const res = await get("/v1/analytics/usage-by-user", "a");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});
