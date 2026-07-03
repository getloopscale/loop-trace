/**
 * Admin key lifecycle — `POST/GET/DELETE /v1/admin/keys[*]` (M22). The admin
 * surface the theo-cloud gateway (Model B broker) mints per-tenant keys against.
 * Ported from the reference `theo-memory` (`handlers/admin-keys.ts`), focused on
 * the security-critical core: mint / list / revoke with anti-escalation. (Key
 * rotation = revoke + mint via these endpoints; a dedicated rotate route is not
 * shipped in M22 — YAGNI until a caller needs atomic rotate-in-place.)
 *
 * Key format `theo_live_` + 32 random bytes (base64url); stored ONLY as a SHA-256
 * hash (the raw secret is returned ONCE on mint, never persisted). Gated upstream
 * by `requireScope('observability:admin')` (a `observability:platform-admin` key satisfies it via the
 * scope hierarchy). Anti-escalation (the CWE-441 mint guard):
 *   - minting `observability:platform-admin` requires the caller to already hold it (403);
 *   - targeting another workspace requires the caller to hold `observability:platform-admin` (403).
 */
import { createHash, randomBytes } from "node:crypto";

import type { Context } from "hono";

import { scopeSatisfies } from "../auth/scope-hierarchy.js";
import { constantTimeEqual } from "../auth/scope-verifier.js";
import type { AuthPool } from "../auth/api-key-verifier.js";

const PREFIX = "theo_live_";
const VALID_SCOPES = new Set([
  "observability:read",
  "observability:write",
  "observability:delete",
  "observability:admin",
  "observability:platform-admin",
]);
const PRIVILEGED_MINT_SCOPES = new Set(["observability:platform-admin"]);
const WORKSPACE_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ID_RE = /^apk-[0-9a-f]{16}$/;
/** Strict ISO-8601 datetime: date + T + time, optional fractional seconds, Z or ±hh:mm offset. */
const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

interface CallerCtx {
  workspaceId: string;
  scopes: readonly string[];
}

/** Resolve the caller's workspace + scopes from its bearer token hash, or the bootstrap implicit platform-admin. */
async function resolveCaller(
  c: Context,
  pool: AuthPool,
  bootstrapToken: string | undefined,
): Promise<CallerCtx | null> {
  const header = c.req.header("authorization") ?? c.req.header("Authorization");
  const m = header?.match(/^Bearer\s+(.+)$/i);
  const token = m?.[1];
  if (token === undefined) return null;
  if (
    bootstrapToken !== undefined &&
    bootstrapToken.trim().length > 0 &&
    // Constant-time compare (F-sec-6): a `===` on the bootstrap secret leaks its
    // length/prefix via timing. Reuses the scope-verifier helper (length-guarded).
    constantTimeEqual(token, bootstrapToken)
  ) {
    // Bootstrap token: implicit platform-admin in the default workspace.
    return { workspaceId: "default", scopes: ["observability:platform-admin"] };
  }
  const hash = createHash("sha256").update(token).digest("hex");
  const { rows } = await pool.query<{ workspace_id: string; scopes: unknown }>(
    `SELECT workspace_id, scopes FROM theo_api_keys
      WHERE key_hash = $1 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > NOW()) AND tenant_id = 'self' LIMIT 1`,
    [hash],
  );
  const row = rows[0];
  if (row === undefined) return null;
  const raw: unknown =
    typeof row.scopes === "string" ? JSON.parse(row.scopes) : row.scopes;
  const scopes = Array.isArray(raw)
    ? raw.filter((s): s is string => typeof s === "string")
    : [];
  return { workspaceId: row.workspace_id, scopes };
}

function newKey(): { secret: string; hash: string; prefix: string } {
  const secret = PREFIX + randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(secret).digest("hex");
  return { secret, hash, prefix: secret.slice(0, 12) };
}
function newId(): string {
  return `apk-${randomBytes(8).toString("hex")}`;
}

/** POST /v1/admin/keys — mint a per-tenant key (anti-escalation enforced). */
export async function createKeyHandler(
  c: Context,
  pool: AuthPool,
  bootstrapToken: string | undefined,
): Promise<Response> {
  let body: { name?: unknown; scopes?: unknown; workspace_id?: unknown; expires_at?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ code: "INVALID_BODY", message: "invalid json body" }, 400);
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length === 0 || name.length > 64) {
    return c.json({ code: "INVALID_NAME", message: "name is required (1-64 chars)" }, 400);
  }
  const scopesIn = Array.isArray(body.scopes)
    ? [...new Set(body.scopes.filter((s): s is string => typeof s === "string"))]
    : [];
  if (scopesIn.length === 0 || scopesIn.some((s) => !VALID_SCOPES.has(s))) {
    return c.json(
      { code: "INVALID_SCOPES", message: "scopes must be a non-empty subset of the lens:* scopes" },
      400,
    );
  }
  let expiresAt: string | null = null;
  if (body.expires_at !== undefined) {
    // Strict ISO-8601 datetime (LENS-AUTH-3): `Date.parse` alone accepts loose
    // formats like "Jan 1 2027", contradicting the "ISO datetime" contract. Require
    // the canonical shape AND a real parse before normalizing.
    if (
      typeof body.expires_at !== "string" ||
      !ISO_DATETIME_RE.test(body.expires_at) ||
      Number.isNaN(Date.parse(body.expires_at))
    ) {
      return c.json({ code: "INVALID_EXPIRES_AT", message: "expires_at must be an ISO-8601 datetime (e.g. 2027-01-01T00:00:00Z)" }, 400);
    }
    expiresAt = new Date(body.expires_at).toISOString();
  }

  let caller: CallerCtx | null;
  try {
    caller = await resolveCaller(c, pool, bootstrapToken);
  } catch {
    return c.json({ code: "SERVICE_UNAVAILABLE", message: "auth backend unavailable" }, 503);
  }
  if (caller === null) {
    return c.json({ code: "AUTH_REQUIRED", message: "caller could not be resolved" }, 401);
  }

  // Target workspace = caller's own unless an explicit workspace_id is given
  // (which requires platform-admin — anti-escalation guard #2).
  let targetWorkspace = caller.workspaceId;
  if (body.workspace_id !== undefined) {
    if (typeof body.workspace_id !== "string" || !WORKSPACE_RE.test(body.workspace_id)) {
      return c.json({ code: "INVALID_WORKSPACE", message: "workspace_id must match [A-Za-z0-9_-]{1,64}" }, 400);
    }
    if (
      body.workspace_id !== caller.workspaceId &&
      !scopeSatisfies(caller.scopes, "observability:platform-admin")
    ) {
      return c.json(
        { code: "INSUFFICIENT_SCOPE_FOR_TARGET", message: "targeting another workspace requires observability:platform-admin" },
        403,
      );
    }
    targetWorkspace = body.workspace_id;
  }

  // Anti-escalation guard #1: a privileged scope can only be minted by a caller who holds it.
  for (const s of scopesIn) {
    if (PRIVILEGED_MINT_SCOPES.has(s) && !scopeSatisfies(caller.scopes, s)) {
      return c.json(
        { code: "INSUFFICIENT_SCOPE_FOR_MINT", message: `minting scope "${s}" requires the caller to hold it` },
        403,
      );
    }
  }

  const id = newId();
  const { secret, hash, prefix } = newKey();
  const WORKSPACE_SQL = `INSERT INTO workspaces (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING`;
  const KEY_SQL = `INSERT INTO theo_api_keys (id, subject, tenant_id, workspace_id, key_name, key_hash, key_prefix, scopes, expires_at)
     VALUES ($1, $2, 'self', $3, $4, $5, $6, $7::jsonb, $8)`;
  const keyParams = [id, targetWorkspace, targetWorkspace, name, hash, prefix, JSON.stringify(scopesIn), expiresAt];
  // Atomic (LENS-AUTH-4): the workspace upsert + key insert run in ONE transaction
  // so a failed key insert never leaves an orphan workspace row. Falls back to two
  // sequential queries when the pool can't pin a connection (e.g. a test stub).
  if (pool.connect !== undefined) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN", []);
      await client.query(WORKSPACE_SQL, [targetWorkspace]);
      await client.query(KEY_SQL, keyParams);
      await client.query("COMMIT", []);
    } catch (err) {
      await client.query("ROLLBACK", []).catch(() => undefined);
      throw err; // fail loud (Rule 8) → onError → 500
    } finally {
      client.release();
    }
  } else {
    await pool.query(WORKSPACE_SQL, [targetWorkspace]);
    await pool.query(KEY_SQL, keyParams);
  }
  return c.json({ id, name, key_prefix: prefix, scopes: scopesIn, workspace_id: targetWorkspace, secret }, 200);
}

/** GET /v1/admin/keys — list the caller's workspace's active keys (no secrets). */
export async function listKeysHandler(
  c: Context,
  pool: AuthPool,
  bootstrapToken: string | undefined,
): Promise<Response> {
  let caller: CallerCtx | null;
  try {
    caller = await resolveCaller(c, pool, bootstrapToken);
  } catch {
    return c.json({ code: "SERVICE_UNAVAILABLE", message: "auth backend unavailable" }, 503);
  }
  if (caller === null) return c.json({ code: "AUTH_REQUIRED", message: "caller could not be resolved" }, 401);
  const { rows } = await pool.query<{
    id: string;
    key_name: string;
    key_prefix: string;
    scopes: unknown;
    created_at: Date;
    expires_at: Date | null;
  }>(
    `SELECT id, key_name, key_prefix, scopes, created_at, expires_at FROM theo_api_keys
      WHERE workspace_id = $1 AND tenant_id = 'self' AND revoked_at IS NULL
      ORDER BY created_at DESC LIMIT 100`,
    [caller.workspaceId],
  );
  const keys = rows.map((r) => ({
    id: r.id,
    name: r.key_name,
    key_prefix: r.key_prefix,
    scopes: typeof r.scopes === "string" ? JSON.parse(r.scopes) : r.scopes,
    created_at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    expires_at: r.expires_at instanceof Date ? r.expires_at.toISOString() : null,
  }));
  return c.json({ keys }, 200);
}

/** DELETE /v1/admin/keys/:id — revoke a key in the caller's workspace (404 leak-guard). */
export async function revokeKeyHandler(
  c: Context,
  pool: AuthPool,
  bootstrapToken: string | undefined,
): Promise<Response> {
  const id = c.req.param("id") ?? "";
  if (!ID_RE.test(id)) return c.json({ code: "NOT_FOUND", message: "not found" }, 404);
  let caller: CallerCtx | null;
  try {
    caller = await resolveCaller(c, pool, bootstrapToken);
  } catch {
    return c.json({ code: "SERVICE_UNAVAILABLE", message: "auth backend unavailable" }, 503);
  }
  if (caller === null) return c.json({ code: "AUTH_REQUIRED", message: "caller could not be resolved" }, 401);
  // Existence-leak guard: not-yours / gone / already-revoked all read as 404.
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE theo_api_keys SET revoked_at = NOW()
      WHERE id = $1 AND workspace_id = $2 AND tenant_id = 'self' AND revoked_at IS NULL RETURNING id`,
    [id, caller.workspaceId],
  );
  if (rows.length === 0) return c.json({ code: "NOT_FOUND", message: "not found" }, 404);
  return c.body(null, 204);
}
