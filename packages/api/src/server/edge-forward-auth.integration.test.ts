import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSpanRepository, migrateLatest } from "@usetheo/lens-core";
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
        JSON.stringify(["lens:read", "lens:write", "lens:delete"]),
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
    app = createApp(made.repo, undefined, {
      pool,
      verifier: new ApiKeyAuthVerifier(pool),
      requireCredential: true,
    });
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE spans, traces, sessions");
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
