/**
 * Tenant isolation — proof that the database enforces it.
 *
 * WHY THIS FILE PROVISIONS ITS OWN ROLE. The rest of the integration suite
 * connects as the database owner (usually a superuser), and both are exempt
 * from Row Level Security — a superuser unconditionally, an owner unless FORCE
 * is set. Tests running that way can show that migration 0033 broke nothing;
 * they cannot show that it protects anything.
 *
 * The engine audit of 2026-08-14 found exactly that trap: a test asserting
 * tenant isolation over a connection that structurally could not be isolated,
 * green for five months over a property nobody had measured. So this file
 * creates a NON-SUPERUSER, NON-OWNER role and measures through it, and fails
 * loudly if that role turns out to be able to bypass RLS anyway.
 *
 * Traces carry prompts, tool arguments and model output — a cross-workspace
 * read here leaks conversations, which is why this file exists at all.
 *
 * @see migrations/0033_rls_fail_closed.sql
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tenantScopedPool } from "./tenant-scoped-pool.js";
import { WorkspaceScopeError, withWorkspaceScope } from "./workspace-scope.js";

const PG_URI = process.env["LOOPTRACE_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

const APP_ROLE = "lens_app_rls_test";
const APP_PASSWORD = "rls-test";
const WS_A = "ws-rls-a";
const WS_B = "ws-rls-b";

let owner: pg.Pool;
let restrictedRaw: pg.Pool;
let scoped: pg.Pool;

function uriForRole(uri: string, role: string, password: string): string {
  const parsed = new URL(uri);
  parsed.username = role;
  parsed.password = password;
  return parsed.toString();
}

/** Drops the test role, first releasing the grants that would block it. */
async function dropRole(pool: pg.Pool): Promise<void> {
  const exists = await pool.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [APP_ROLE]);
  if (exists.rowCount === 0) return;
  await pool.query(`DROP OWNED BY ${APP_ROLE}`);
  await pool.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
}

suite("tenant isolation is enforced by PostgreSQL", () => {
  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: PG_URI as string, max: 4 });

    await dropRole(owner);
    await owner.query(
      `CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS`,
    );
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await owner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
    );
    await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);

    for (const ws of [WS_A, WS_B]) {
      await owner.query(
        `INSERT INTO workspaces (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
        [ws, `workspace ${ws}`],
      );
      await owner.query(
        `INSERT INTO sessions (session_id, workspace_id, first_seen_at, last_seen_at)
         VALUES ($1, $2, now(), now())
         ON CONFLICT DO NOTHING`,
        [`sess-${ws}`, ws],
      );
    }

    const appUri = uriForRole(PG_URI as string, APP_ROLE, APP_PASSWORD);
    restrictedRaw = new pg.Pool({ connectionString: appUri, max: 4 });
    scoped = tenantScopedPool(new pg.Pool({ connectionString: appUri, max: 4 }));
  }, 120_000);

  afterAll(async () => {
    await restrictedRaw?.end();
    await scoped?.end();
    await owner.query(`DELETE FROM sessions WHERE session_id IN ($1, $2)`, [
      `sess-${WS_A}`,
      `sess-${WS_B}`,
    ]);
    await owner.query(`DELETE FROM workspaces WHERE id IN ($1, $2)`, [WS_A, WS_B]);
    await dropRole(owner).catch(() => undefined);
    await owner.end();
  });

  it("the test role can actually be bound by RLS (guards against a vacuous suite)", async () => {
    const { rows } = await restrictedRaw.query<{ bypass: boolean; superuser: boolean }>(
      `SELECT rolbypassrls AS bypass, rolsuper AS superuser
         FROM pg_roles WHERE rolname = current_user`,
    );
    expect(rows[0]?.bypass, "the role must not hold BYPASSRLS").toBe(false);
    expect(rows[0]?.superuser, "a superuser bypasses RLS unconditionally").toBe(false);

    const own = await restrictedRaw.query<{ is_owner: boolean }>(
      `SELECT pg_get_userbyid(relowner) = current_user AS is_owner
         FROM pg_class WHERE relname = 'sessions'`,
    );
    expect(own.rows[0]?.is_owner, "an owner is exempt from its own policies").toBe(false);
  });

  it("a request scoped to one workspace reads only that workspace", async () => {
    const seen = await withWorkspaceScope(WS_A, async () => {
      const { rows } = await scoped.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM sessions WHERE session_id IN ($1, $2)`,
        [`sess-${WS_A}`, `sess-${WS_B}`],
      );
      return rows.map((r) => r.workspace_id);
    });
    expect(seen).toEqual([WS_A]);
  });

  it("a statement with no workspace context is refused before reaching the database", async () => {
    await expect(scoped.query(`SELECT workspace_id FROM sessions`)).rejects.toBeInstanceOf(
      WorkspaceScopeError,
    );
  });

  it("the database refuses an unscoped read even on a raw connection", async () => {
    const { rows } = await restrictedRaw.query(`SELECT workspace_id FROM sessions`);
    expect(rows).toHaveLength(0);
  });

  it("a request cannot write a session into another workspace", async () => {
    await expect(
      withWorkspaceScope(WS_A, async () => {
        await scoped.query(
          `INSERT INTO sessions (session_id, workspace_id, first_seen_at, last_seen_at)
           VALUES ($1, $2, now(), now())`,
          ["sess-forged", WS_B],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it("a request cannot update or delete another workspace rows", async () => {
    const { updated, deleted } = await withWorkspaceScope(WS_A, async () => {
      const u = await scoped.query(`UPDATE sessions SET last_seen_at = now() WHERE session_id = $1`, [
        `sess-${WS_B}`,
      ]);
      const d = await scoped.query(`DELETE FROM sessions WHERE session_id = $1`, [`sess-${WS_B}`]);
      return { updated: u.rowCount ?? 0, deleted: d.rowCount ?? 0 };
    });
    expect(updated).toBe(0);
    expect(deleted).toBe(0);

    // Verified from outside the policy so a filtered read cannot fake success.
    const survivor = await owner.query(`SELECT 1 FROM sessions WHERE session_id = $1`, [
      `sess-${WS_B}`,
    ]);
    expect(survivor.rowCount).toBe(1);
  });

  it("the credential table stays readable without a scope, and that is deliberate", async () => {
    // Credential resolution DISCOVERS the workspace, so it runs before any scope
    // exists. Policing that table by workspace would be circular and would fail
    // every login closed. Asserted here so the exemption stays a decision rather
    // than drifting into an oversight nobody notices.
    const { rows } = await restrictedRaw.query<{ enabled: boolean }>(
      `SELECT relrowsecurity AS enabled FROM pg_class WHERE relname = 'looptrace_api_keys'`,
    );
    expect(rows[0]?.enabled).toBe(false);
  });
});
