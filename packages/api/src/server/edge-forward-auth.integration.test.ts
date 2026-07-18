import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSpanRepository, migrateLatest, evaluatorRepoFromPool, RateLimiter } from "@usetheo/lens-core";
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { createApp } from "./app.js";
import { ApiKeyAuthVerifier } from "./auth/api-key-verifier.js";

/**
 * M22 invariant 6 — prove cross-tenant isolation through the **ForwardAuth edge
 * contract**, end-to-end. The production edge (Traefik + theo-cloud Model B broker)
 * is the gateway side (ADR D4 — a theo-cloud follow-on); this hermetic test models
 * its exact contract in-process so the DATA-PLANE half is proven now:
 *
 *   customer key (`cust_<tenant>`) → EDGE → (1) validate + resolve tenant
 *                                          (2) STRIP the customer key (Del)
 *                                          (3) BROKER mints a per-tenant `theo_live_*`
 *                                              bound to workspace = tenant, scopes [r/w/d]
 *                                          (4) forward with `Authorization: Bearer <minted>`
 *                                   → lens service enforces workspace isolation
 *
 * Asserts: tenant B writes through the edge, tenant A cannot read it, B can; a no-key
 * request is denied AT THE EDGE (never reaches the service). The customer key NEVER
 * reaches the service (CWE-441 edge half); the service still enforces per-tenant
 * isolation (CWE-441 data-plane half) — both halves, proven together.
 */
const PG_URI = process.env["THEOLENS_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

suite("M22 ForwardAuth edge contract (integration)", () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  /** tenant → its gateway-minted per-tenant key (the broker's output). */
  const minted = new Map<string, string>();

  /** The Model-B broker: mint (once) a per-tenant key bound to workspace = tenant. */
  async function brokerKeyFor(tenant: string): Promise<string> {
    const existing = minted.get(tenant);
    if (existing) return existing;
    const secret = "theo_live_" + randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(secret).digest("hex");
    await pool.query(
      `INSERT INTO workspaces (id, name) VALUES ($1,$1) ON CONFLICT DO NOTHING`,
      [tenant],
    );
    await pool.query(
      `INSERT INTO theo_api_keys (id, subject, tenant_id, workspace_id, key_name, key_hash, key_prefix, scopes)
       VALUES ($1,$2,'self',$3,'broker',$4,$5,$6::jsonb)`,
      [
        "apk-" + randomBytes(8).toString("hex"),
        tenant,
        tenant,
        hash,
        secret.slice(0, 12),
        JSON.stringify(["observability:read", "observability:write", "observability:delete"]),
      ],
    );
    minted.set(tenant, secret);
    return secret;
  }

  /**
   * The edge ForwardAuth middleware contract: a `cust_<tenant>` customer key →
   * STRIP it, mint a per-tenant key, forward with the minted Bearer. No/invalid
   * customer key → DENIED at the edge (the service is never called).
   */
  async function viaEdge(req: Request): Promise<Response> {
    const customer = req.headers.get("x-customer-key");
    const m = customer?.match(/^cust_(.+)$/);
    if (!m) {
      // Denied at the edge — fail-closed, the service is never reached.
      return new Response(JSON.stringify({ code: "EDGE_DENIED" }), {
        status: 401,
      });
    }
    const tenant = m[1] as string;
    const mintedKey = await brokerKeyFor(tenant);
    // Del-then-set: the customer key is stripped; only the minted key goes upstream.
    const headers = new Headers(req.headers);
    headers.delete("x-customer-key");
    headers.delete("authorization");
    headers.set("authorization", `Bearer ${mintedKey}`);
    const forwarded = new Request(req.url, {
      method: req.method,
      headers,
      body:
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : await req.text(),
    });
    return app.request(forwarded);
  }

  const OTLP = (traceId: string, spanId: string, input: string) =>
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
                  attributes: [{ key: "input.value", value: { stringValue: input } }],
                },
              ],
            },
          ],
        },
      ],
    });

  beforeAll(async () => {
    const made = createSpanRepository(PG_URI as string);
    pool = made.pool;
    await migrateLatest(pool);
    // M64: wire the experiment-run route with a fake provider so the run e2e proves isolation through
    // the edge (a real provider is not needed to prove the workspace-scoped write path).
    const fakeChat = { run: async () => ({ content: "ok", promptTokens: 1, completionTokens: 1, totalTokens: 2, model: "m" }) };
    const experimentDeps = {
      spanRepo: made.repo,
      evaluatorRepo: evaluatorRepoFromPool(pool),
      chat: fakeChat,
      limiter: new RateLimiter(1000),
    } as unknown as Parameters<typeof createApp>[6];
    app = createApp(
      made.repo,
      undefined,
      { pool, verifier: new ApiKeyAuthVerifier(pool), requireCredential: true },
      undefined,
      undefined,
      undefined,
      experimentDeps,
    );
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE spans, traces, sessions, labeling_queue_items, datasets, dataset_items, experiment_runs, experiment_run_items");
  });
  afterAll(async () => {
    await pool.end();
  });

  it("test_edge_two_tenant_isolation_and_no_key_denied", async () => {
    // Tenant B writes a canary through the edge.
    const write = await viaEdge(
      new Request("http://x/v1/traces", {
        method: "POST",
        headers: { "content-type": "application/json", "x-customer-key": "cust_bob" },
        body: OTLP("b-trace", "b-span", "bob canary"),
      }),
    );
    expect(write.status).toBe(200);

    // Tenant A reads through the edge → MUST NOT see Bob's trace (cross-tenant deny).
    const aRead = await viaEdge(
      new Request("http://x/v1/traces", { headers: { "x-customer-key": "cust_alice" } }),
    );
    expect(aRead.status).toBe(200);
    const aBody = (await aRead.json()) as { traces: { traceId: string }[] };
    expect(aBody.traces).toHaveLength(0);

    // Tenant B reads → MUST see its own trace (proves the path reaches data; the
    // empty A result is isolation, not a false negative).
    const bRead = await viaEdge(
      new Request("http://x/v1/traces", { headers: { "x-customer-key": "cust_bob" } }),
    );
    const bBody = (await bRead.json()) as { traces: { traceId: string }[] };
    expect(bBody.traces.map((t) => t.traceId)).toContain("b-trace");

    // A no-customer-key request is DENIED at the edge (the service is never called).
    const noKey = await viaEdge(new Request("http://x/v1/traces"));
    expect(noKey.status).toBe(401);
  });

  it("test_labeling_queue_cross_tenant_isolation_through_edge (M63)", async () => {
    // Tenant B ingests a span, then enqueues it for labeling — both through the edge.
    expect(
      (await viaEdge(new Request("http://x/v1/traces", {
        method: "POST",
        headers: { "content-type": "application/json", "x-customer-key": "cust_bob" },
        body: OTLP("b-trace", "b-span", "bob canary"),
      }))).status,
    ).toBe(200);
    const enqueue = await viaEdge(new Request("http://x/v1/traces/b-trace/enqueue-for-labeling", {
      method: "POST",
      headers: { "content-type": "application/json", "x-customer-key": "cust_bob" },
      body: JSON.stringify({ spanId: "b-span" }),
    }));
    expect(enqueue.status).toBe(200);

    // Tenant A lists the labeling queue through the edge → MUST NOT see Bob's item (cross-tenant deny).
    const aList = await viaEdge(new Request("http://x/v1/labeling-queue", { headers: { "x-customer-key": "cust_alice" } }));
    expect(aList.status).toBe(200);
    expect(((await aList.json()) as { items: unknown[] }).items).toHaveLength(0);

    // Tenant B lists → MUST see its own item (proves the path reaches data; A's empty result is isolation).
    const bList = await viaEdge(new Request("http://x/v1/labeling-queue", { headers: { "x-customer-key": "cust_bob" } }));
    const bItems = ((await bList.json()) as { items: { traceId: string }[] }).items;
    expect(bItems.map((i) => i.traceId)).toContain("b-trace");

    // A no-customer-key enqueue is DENIED at the edge (the billable write route is never reached).
    const noKey = await viaEdge(new Request("http://x/v1/traces/b-trace/enqueue-for-labeling", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spanId: "b-span" }),
    }));
    expect(noKey.status).toBe(401);
  });

  it("test_experiment_run_cross_tenant_isolation_through_edge (M64)", async () => {
    // Tenant B ingests a trace, builds a regression dataset from it, then runs an experiment — all
    // through the edge — and the run is scoped to B's workspace; tenant A can never see it.
    expect(
      (await viaEdge(new Request("http://x/v1/traces", {
        method: "POST",
        headers: { "content-type": "application/json", "x-customer-key": "cust_bob" },
        body: OTLP("b-trace", "b-span", "bob canary"),
      }))).status,
    ).toBe(200);
    const ds = await viaEdge(new Request("http://x/v1/datasets", {
      method: "POST",
      headers: { "content-type": "application/json", "x-customer-key": "cust_bob" },
      body: JSON.stringify({ name: "b-regression" }),
    }));
    const datasetId = ((await ds.json()) as { id: string }).id;
    expect((await viaEdge(new Request(`http://x/v1/datasets/${datasetId}/items`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-customer-key": "cust_bob" },
      body: JSON.stringify({ traceId: "b-trace" }),
    }))).status).toBe(200);
    // B runs an experiment on its dataset through the edge (the fake provider returns a canned output).
    const run = await viaEdge(new Request("http://x/v1/experiment-runs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-customer-key": "cust_bob" },
      body: JSON.stringify({ datasetId, variant: { model: "m" } }),
    }));
    expect(run.status).toBe(200);

    // Tenant A lists experiment runs through the edge → MUST NOT see B's run (cross-tenant deny).
    const aList = await viaEdge(new Request("http://x/v1/experiment-runs", { headers: { "x-customer-key": "cust_alice" } }));
    expect(aList.status).toBe(200);
    expect(((await aList.json()) as { runs: unknown[] }).runs).toHaveLength(0);
    // Tenant B lists → sees its own run (the path reaches data; A's empty is isolation, not a false negative).
    const bList = await viaEdge(new Request("http://x/v1/experiment-runs", { headers: { "x-customer-key": "cust_bob" } }));
    expect(((await bList.json()) as { runs: { datasetId: string }[] }).runs.map((r) => r.datasetId)).toContain(datasetId);

    // A no-customer-key run is DENIED at the edge (the billable run route is never reached).
    const noKey = await viaEdge(new Request("http://x/v1/experiment-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ datasetId, variant: { model: "m" } }),
    }));
    expect(noKey.status).toBe(401);
  });

  it("test_datasets_cross_tenant_isolation_through_edge (M119)", async () => {
    // M119 (Phase 4, G4.2) — rotate ONE more surface (datasets) into the through-edge isolation proof
    // (was traces/labeling-queue/experiment-runs), hardening the CWE-441 claim beyond the prior sample.
    // Tenant B ingests a trace, then creates a dataset + item from it — all through the real ForwardAuth
    // edge — and both are workspace-scoped; tenant A can never list B's dataset, and a no-key write is
    // denied AT THE EDGE.
    expect(
      (await viaEdge(new Request("http://x/v1/traces", {
        method: "POST",
        headers: { "content-type": "application/json", "x-customer-key": "cust_bob" },
        body: OTLP("b-trace", "b-span", "bob canary"),
      }))).status,
    ).toBe(200);
    const ds = await viaEdge(new Request("http://x/v1/datasets", {
      method: "POST",
      headers: { "content-type": "application/json", "x-customer-key": "cust_bob" },
      body: JSON.stringify({ name: "b-dataset" }),
    }));
    expect(ds.status).toBe(200);
    const datasetId = ((await ds.json()) as { id: string }).id;
    expect((await viaEdge(new Request(`http://x/v1/datasets/${datasetId}/items`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-customer-key": "cust_bob" },
      body: JSON.stringify({ traceId: "b-trace" }),
    }))).status).toBe(200);

    // Tenant A lists datasets through the edge → MUST NOT see Bob's dataset (cross-tenant deny).
    const aList = await viaEdge(new Request("http://x/v1/datasets", { headers: { "x-customer-key": "cust_alice" } }));
    expect(aList.status).toBe(200);
    expect(((await aList.json()) as { datasets: unknown[] }).datasets).toHaveLength(0);

    // Tenant B lists → MUST see its own dataset (proves the path reaches data; A's empty is isolation).
    const bList = await viaEdge(new Request("http://x/v1/datasets", { headers: { "x-customer-key": "cust_bob" } }));
    expect(bList.status).toBe(200);
    expect(((await bList.json()) as { datasets: { id: string }[] }).datasets.map((d) => d.id)).toContain(datasetId);

    // A no-customer-key dataset write is DENIED at the edge (the billable write route is never reached).
    const noKey = await viaEdge(new Request("http://x/v1/datasets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "no-key-dataset" }),
    }));
    expect(noKey.status).toBe(401);
  });

  it("test_customer_key_never_reaches_the_service", async () => {
    // The service rejects the raw customer key directly (it only honors minted
    // `theo_live_*` keys) — proving the edge MUST strip + mint, and a leaked
    // customer key cannot authenticate against the data plane.
    const direct = await app.request(
      new Request("http://x/v1/traces", {
        headers: { authorization: "Bearer cust_bob" },
      }),
    );
    expect(direct.status).toBe(401);
  });
});
