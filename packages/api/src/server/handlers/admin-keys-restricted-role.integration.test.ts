/**
 * Minting a key as the role a real deployment connects with.
 *
 * The rest of the integration suite connects as a superuser, which Row Level
 * Security never applies to. A deployment that follows least privilege (a
 * database owned by a NOSUPERUSER role, as an operator-managed PostgreSQL
 * provisions it) is subject to the FORCE policies of migration 0033, and the
 * mint has to create the workspace row under them.
 */
import { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrateLatest } from "@looptrace/core/infra";

import { createKeyHandler } from "./admin-keys.js";

const PG_URI = process.env["LOOPTRACE_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

const APP_ROLE = "looptrace_mint_rls_test";
const APP_PASSWORD = "mint-rls-test";
const BOOTSTRAP = "bootstrap-token-for-the-restricted-role-test";
const WORKSPACE = "ws-mint-rls";

let owner: pg.Pool;
let restricted: pg.Pool;
let app: Hono;

function uriForRole(uri: string, role: string, password: string): string {
  const parsed = new URL(uri);
  parsed.username = role;
  parsed.password = password;
  return parsed.toString();
}

async function dropRole(pool: pg.Pool): Promise<void> {
  const exists = await pool.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE]);
  if (exists.rowCount === 0) return;
  await pool.query(`DROP OWNED BY ${APP_ROLE}`);
  await pool.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
}

async function mint(workspaceId: string): Promise<Response> {
  return app.request("/v1/admin/keys", {
    method: "POST",
    headers: { authorization: `Bearer ${BOOTSTRAP}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "restricted-role", scopes: ["observability:read"], workspace_id: workspaceId }),
  });
}

suite("minting a key as a role Row Level Security applies to", () => {
  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: PG_URI as string, max: 2 });
    await migrateLatest(owner);
    await dropRole(owner);
    await owner.query(`DELETE FROM looptrace_api_keys WHERE workspace_id = $1`, [WORKSPACE]);
    await owner.query(`DELETE FROM workspaces WHERE id = $1`, [WORKSPACE]);
    await owner.query(`CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS`);
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await owner.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`);

    restricted = new pg.Pool({
      connectionString: uriForRole(PG_URI as string, APP_ROLE, APP_PASSWORD),
      max: 2,
    });
    app = new Hono();
    app.post("/v1/admin/keys", (c) => createKeyHandler(c, restricted, BOOTSTRAP));
  }, 120_000);

  afterAll(async () => {
    await restricted?.end();
    await owner.query(`DELETE FROM looptrace_api_keys WHERE workspace_id = $1`, [WORKSPACE]);
    await owner.query(`DELETE FROM workspaces WHERE id = $1`, [WORKSPACE]);
    await dropRole(owner);
    await owner.end();
  });

  it("the role is one the policies apply to", async () => {
    const { rows } = await restricted.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("mints the first key of a workspace that does not exist yet", async () => {
    const res = await mint(WORKSPACE);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { workspace_id: string; secret: string };
    expect(body.workspace_id).toBe(WORKSPACE);
    expect(body.secret.startsWith("looptrace_live_")).toBe(true);
    const created = await owner.query(`SELECT 1 FROM workspaces WHERE id = $1`, [WORKSPACE]);
    expect(created.rowCount).toBe(1);
  });

  it("mints a second key in the workspace it created", async () => {
    const res = await mint(WORKSPACE);

    expect(res.status).toBe(200);
  });

  it("leaves no workspace context on the connection it used", async () => {
    await mint(WORKSPACE);

    // max: 2, so one of these is a connection a mint ran on.
    const settings = await Promise.all(
      [0, 1].map(() => restricted.query<{ ws: string | null }>(`SELECT current_setting('app.workspace_id', true) AS ws`)),
    );
    for (const { rows } of settings) expect(rows[0]?.ws ?? "").toBe("");
  });
});
