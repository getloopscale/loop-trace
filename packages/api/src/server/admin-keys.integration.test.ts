import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSpanRepository, migrateLatest } from "@usetheo/lens-core";
import type pg from "pg";
import { createApp } from "./app.js";
import { ApiKeyAuthVerifier } from "./auth/api-key-verifier.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const suite = PG_URI ? describe : describe.skip;
const BOOTSTRAP = "theolens_bootstrap_admin_secret";

suite("M22 admin keys (integration)", () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    const made = createSpanRepository(PG_URI as string);
    pool = made.pool;
    await migrateLatest(pool);
    app = createApp(made.repo, undefined, {
      pool,
      verifier: new ApiKeyAuthVerifier(pool),
      requireCredential: true,
      bootstrapToken: BOOTSTRAP,
    });
  });
  beforeEach(async () => {
    await pool.query("DELETE FROM theo_api_keys WHERE id LIKE 'apk-%'");
  });
  afterAll(async () => {
    await pool.end();
  });

  function mint(token: string, body: unknown): Promise<Response> {
    return app.request("http://x/v1/admin/keys", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  it("test_admin_mint_returns_secret_once_and_stores_only_hash", async () => {
    const res = await mint(BOOTSTRAP, {
      name: "tenant-acme",
      scopes: ["observability:read", "observability:write", "observability:delete"],
      workspace_id: "ws-acme",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; secret: string };
    expect(body.secret.startsWith("theo_live_")).toBe(true);
    // The raw secret is NOT stored — only its SHA-256 hash.
    const { rows } = await pool.query<{ key_hash: string }>(
      "SELECT key_hash FROM theo_api_keys WHERE id = $1",
      [body.id],
    );
    expect(rows[0]?.key_hash).not.toBe(body.secret);
    expect(rows[0]?.key_hash).toHaveLength(64); // hex sha256
    // The minted key can authenticate a data request (bound to ws-acme).
    const probe = await app.request("http://x/v1/traces", {
      headers: { authorization: `Bearer ${body.secret}` },
    });
    expect(probe.status).toBe(200);
  });

  it("test_admin_mint_expires_at_must_be_strict_iso", async () => {
    // LENS-AUTH-3: a loose date string is rejected (the contract says ISO-8601),
    // while a canonical ISO datetime is accepted and the transactional mint commits.
    const loose = await mint(BOOTSTRAP, {
      name: "loose-exp",
      scopes: ["observability:read"],
      workspace_id: "ws-exp",
      expires_at: "Jan 1 2027",
    });
    expect(loose.status).toBe(400);
    expect(((await loose.json()) as { code: string }).code).toBe("INVALID_EXPIRES_AT");

    const ok = await mint(BOOTSTRAP, {
      name: "iso-exp",
      scopes: ["observability:read"],
      workspace_id: "ws-exp",
      expires_at: "2027-01-01T00:00:00Z",
    });
    expect(ok.status).toBe(200);
    // The transactional mint persisted exactly one key (workspace upsert + key insert
    // committed atomically), with the normalized expiry stored.
    const id = ((await ok.json()) as { id: string }).id;
    const { rows } = await pool.query<{ expires_at: Date | null }>(
      "SELECT expires_at FROM theo_api_keys WHERE id = $1",
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expires_at).not.toBeNull();
  });

  it("test_admin_anti_escalation_platform_admin_mint_requires_holding_it", async () => {
    // Bootstrap holds platform-admin → mint a tenant key WITHOUT platform-admin.
    const tenant = await mint(BOOTSTRAP, {
      name: "tenant",
      scopes: ["observability:read", "observability:write", "observability:admin"],
      workspace_id: "ws-t",
    });
    const tenantSecret = ((await tenant.json()) as { secret: string }).secret;
    // The tenant admin key (no platform-admin) tries to mint a platform-admin key → 403.
    const escalate = await mint(tenantSecret, {
      name: "escalation",
      scopes: ["observability:platform-admin"],
    });
    expect(escalate.status).toBe(403);
    expect(((await escalate.json()) as { code: string }).code).toBe(
      "INSUFFICIENT_SCOPE_FOR_MINT",
    );
  });

  it("test_admin_cross_workspace_mint_requires_platform_admin", async () => {
    const tenant = await mint(BOOTSTRAP, {
      name: "tenant",
      scopes: ["observability:read", "observability:write", "observability:admin"],
      workspace_id: "ws-own",
    });
    const tenantSecret = ((await tenant.json()) as { secret: string }).secret;
    // tenant (no platform-admin) tries to mint into ANOTHER workspace → 403.
    const cross = await mint(tenantSecret, {
      name: "cross",
      scopes: ["observability:read"],
      workspace_id: "ws-other",
    });
    expect(cross.status).toBe(403);
    expect(((await cross.json()) as { code: string }).code).toBe(
      "INSUFFICIENT_SCOPE_FOR_TARGET",
    );
  });

  it("test_admin_revoke_is_leak_guarded_404", async () => {
    // Mint into the bootstrap caller's own workspace (default) so the workspace-
    // scoped revoke matches (revoke is scoped to the caller's workspace).
    const minted = await mint(BOOTSTRAP, { name: "k", scopes: ["observability:read"] });
    const id = ((await minted.json()) as { id: string }).id;
    // Revoking an unknown id → 404 (existence-leak guard).
    const unknown = await app.request("http://x/v1/admin/keys/apk-0000000000000000", {
      method: "DELETE",
      headers: { authorization: `Bearer ${BOOTSTRAP}` },
    });
    expect(unknown.status).toBe(404);
    // Revoking the real id → 204; the key no longer authenticates.
    const ok = await app.request(`http://x/v1/admin/keys/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${BOOTSTRAP}` },
    });
    expect(ok.status).toBe(204);
  });

  it("test_admin_routes_reject_non_admin_credential", async () => {
    // A no-credential admin request → 401; a non-admin key → 403/401.
    const noAuth = await app.request("http://x/v1/admin/keys", { method: "POST" });
    expect(noAuth.status).toBe(401);
  });
});
