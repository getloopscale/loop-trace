/**
 * Scope verifier middleware — gates `/v1/admin/keys/*` (M22). Ported from the
 * reference capability `theo-memory` (`auth/scope-verifier.ts`) with a `memory:` →
 * `lens:` swap. See `theo-data/README.md § 4`.
 *
 * Compatible only with `theo_live_*` keys: hashes the token, looks up
 * `theo_api_keys.scopes`, checks the required scope (honoring `scopeSatisfies` so
 * `lens:platform-admin` reaches the `lens:admin` gate). A bootstrap admin token
 * (env) bypasses the scope check — it IS admin by definition (bootstraps the first
 * admin key). Mounted on the admin sub-app BEFORE the generic bearer middleware.
 *
 *   401 AUTH_REQUIRED      — no Authorization header
 *   401 INVALID_API_KEY    — token not found / inactive
 *   403 SCOPE_INSUFFICIENT — token found but lacks the required scope
 *   503 SERVICE_UNAVAILABLE — auth backend down (fail closed, never grant)
 */
import { createHash, timingSafeEqual } from "node:crypto";

import type { MiddlewareHandler } from "hono";

import type { AuthPool } from "./api-key-verifier.js";
import { scopeSatisfies } from "./scope-hierarchy.js";

const PREFIX = "theo_live_";

const SELECT_SCOPES_BY_HASH_SQL = `\
SELECT scopes FROM theo_api_keys
 WHERE key_hash = $1
   AND revoked_at IS NULL
   AND (expires_at IS NULL OR expires_at > NOW())
   AND tenant_id = 'self'
 LIMIT 1`;

export interface RequireScopeOptions {
  readonly pool: AuthPool;
  readonly requiredScope: string;
  /** Optional env-sourced bootstrap admin token; an exact match bypasses the scope check. */
  readonly bootstrapToken?: string;
}

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? (match[1] ?? null) : null;
}

/** Constant-time compare with a length pre-check (timingSafeEqual throws on length mismatch). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function requireScope(opts: RequireScopeOptions): MiddlewareHandler {
  return async (c, next) => {
    const token = extractBearer(
      c.req.header("authorization") ?? c.req.header("Authorization"),
    );
    if (!token) {
      return c.json(
        { code: "AUTH_REQUIRED", message: "Authorization header is required." },
        401,
        { "WWW-Authenticate": "Bearer" },
      );
    }

    // Bootstrap bypass — exact match against the env token (whitespace-only rejected).
    if (opts.bootstrapToken && opts.bootstrapToken.trim().length > 0) {
      if (constantTimeEqual(token, opts.bootstrapToken)) {
        await next();
        return;
      }
    }

    if (!token.startsWith(PREFIX) || token.length <= PREFIX.length) {
      return c.json(
        { code: "INVALID_API_KEY", message: "API key not recognized." },
        401,
        { "WWW-Authenticate": 'Bearer error="invalid_token"' },
      );
    }
    const hash = createHash("sha256").update(token).digest("hex");
    let rows: { scopes: unknown }[];
    try {
      ({ rows } = await opts.pool.query<{ scopes: unknown }>(
        SELECT_SCOPES_BY_HASH_SQL,
        [hash],
      ));
    } catch {
      // Fail CLOSED on auth-backend failure — 503, never a granted scope.
      return c.json(
        {
          code: "SERVICE_UNAVAILABLE",
          message: "Authentication backend unavailable.",
        },
        503,
      );
    }
    if (rows.length === 0) {
      return c.json(
        { code: "INVALID_API_KEY", message: "API key not recognized." },
        401,
        { "WWW-Authenticate": 'Bearer error="invalid_token"' },
      );
    }
    let scopes: readonly string[] = [];
    try {
      const rawSrc = rows[0]?.scopes;
      const raw: unknown =
        typeof rawSrc === "string" ? JSON.parse(rawSrc) : rawSrc;
      if (Array.isArray(raw)) scopes = raw as string[];
    } catch {
      scopes = [];
    }
    if (!scopeSatisfies(scopes, opts.requiredScope)) {
      return c.json(
        {
          code: "SCOPE_INSUFFICIENT",
          message: `Required scope "${opts.requiredScope}" not granted by this API key.`,
        },
        403,
      );
    }
    await next();
    return;
  };
}
