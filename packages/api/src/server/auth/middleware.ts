/**
 * Hono bearer-auth middleware factory (M22). Ported from the reference capability
 * `loopmem` (`auth/middleware.ts`) with a `memory:` → `lens:` scope swap. See
 * `data-plane/README.md § 3.1`/`§ 3.3`/`§ 3.4`.
 *
 * Resolves a {@link Principal} from the credential and sets it on context; handlers
 * read the workspace from the Principal, never the body (invariant 3). Fail-closed:
 * backend throw → 503 (never a privileged default); missing cred in multi-tenant
 * mode → 401 (invariant 5).
 */
import {
  type AuthVerifier,
  type Principal,
  type WorkspaceRole,
  DEFAULT_OWNER_USER_ID,
  DEFAULT_WORKSPACE_ID,
  roleSatisfies,
} from "@looptrace/core";
import type { Context, MiddlewareHandler } from "hono";

import { BearerAuthVerifier, readApiKey } from "./bearer-verifier.js";
import { scopeSatisfies } from "./scope-hierarchy.js";

const BEARER_SCHEME_RE = /^bearer\s+(.+)$/i;

/**
 * The `default`-workspace Principal used when no credential is configured
 * (single-tenant dev / no-key deployments collapse to one workspace, which has no
 * cross-tenant IDOR). Acts as the seeded `default-owner` owner so management routes
 * keep working in single-tenant mode.
 */
const DEFAULT_PRINCIPAL: Principal = {
  workspaceId: DEFAULT_WORKSPACE_ID,
  userId: DEFAULT_OWNER_USER_ID,
  role: "owner",
  scopes: ["observability:read", "observability:write", "observability:delete"],
};

/**
 * Read the Principal injected by {@link bearerAuth}. Falls back to the
 * `default`-workspace owner when none is present (auth not mounted, e.g. a unit
 * test hitting a handler directly).
 */
export function getPrincipal(c: Context): Principal {
  return (c.get("principal") as Principal | undefined) ?? DEFAULT_PRINCIPAL;
}

/** Gate a route on a minimum workspace role. Mounted AFTER {@link bearerAuth}. */
export function requireRole(min: WorkspaceRole): MiddlewareHandler {
  return async (c, next) => {
    const { role } = getPrincipal(c);
    if (!roleSatisfies(role, min)) {
      return c.json(
        {
          code: "INSUFFICIENT_ROLE",
          message: `Required role "${min}" not held by this credential.`,
          required: min,
          actual: role,
        },
        403,
      );
    }
    await next();
    return;
  };
}

/**
 * Gate a data route on a required scope, checked against the Principal resolved by
 * {@link bearerAuth}. The data-plane half of CWE-441: because `observability:platform-admin`
 * implies ONLY `observability:admin` (key lifecycle), the gateway's provisioning credential
 * is 403 on every data verb — least privilege (NIST AC-6).
 */
export function requireScopeOnPrincipal(required: string): MiddlewareHandler {
  return async (c, next) => {
    const { scopes } = getPrincipal(c);
    if (!scopeSatisfies(scopes, required)) {
      return c.json(
        {
          code: "INSUFFICIENT_SCOPE",
          message: `Required scope "${required}" not held by this credential.`,
          required,
          actual: scopes,
        },
        403,
      );
    }
    await next();
    return;
  };
}

async function resolvePrincipalFrom(
  verifier: AuthVerifier,
  token: string,
  requireCredential: boolean,
): Promise<Principal | null> {
  if (verifier.resolvePrincipal !== undefined) {
    return verifier.resolvePrincipal(token);
  }
  // Fail-closed: a verify-only verifier MUST NOT collapse to the privileged
  // DEFAULT_PRINCIPAL in multi-tenant mode.
  if (requireCredential) return null;
  return (await verifier.verify(token)) ? DEFAULT_PRINCIPAL : null;
}

/**
 * Parse `LOOPTRACE_REQUIRE_CREDENTIAL`. Only the literal `"true"`/`"1"` (case-
 * insensitive) enable fail-closed mode; everything else leaves the single-tenant
 * default.
 */
export function parseRequireCredentialEnv(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1";
}

/**
 * Build the bearer-auth middleware. No `LOOPTRACE_API_KEY` + no override + not
 * multi-tenant → collapse to the `default` workspace (single-tenant). Multi-tenant
 * mode rejects a missing credential with 401.
 */
export function bearerAuth(
  verifier?: AuthVerifier,
  opts: { readonly requireCredential?: boolean } = {},
): MiddlewareHandler {
  const apiKey = readApiKey();
  const hoistedVerifier =
    verifier ?? (apiKey !== undefined ? new BearerAuthVerifier(apiKey) : null);
  const requireCredential = opts.requireCredential === true;

  return async (c, next) => {
    if (hoistedVerifier === null) {
      if (requireCredential) {
        return c.json(
          {
            code: "CREDENTIAL_REQUIRED",
            message: "A credential is required (multi-tenant mode).",
          },
          401,
          { "WWW-Authenticate": "Bearer" },
        );
      }
      c.set("principal", DEFAULT_PRINCIPAL);
      await next();
      return;
    }

    const authHeader =
      c.req.header("authorization") ?? c.req.header("Authorization");
    if (authHeader === undefined) {
      return c.json(
        { code: "UNAUTHORIZED", message: "Bearer token required" },
        401,
        { "WWW-Authenticate": "Bearer" },
      );
    }

    const match = BEARER_SCHEME_RE.exec(authHeader);
    if (match === null) {
      return c.json(
        { code: "UNAUTHORIZED", message: "Bearer scheme expected" },
        401,
        { "WWW-Authenticate": "Bearer" },
      );
    }
    const token = match[1] ?? "";

    let principal: Principal | null;
    try {
      principal = await resolvePrincipalFrom(
        hoistedVerifier,
        token,
        requireCredential,
      );
    } catch {
      return c.json(
        {
          code: "SERVICE_UNAVAILABLE",
          message: "Authentication backend unavailable",
        },
        503,
      );
    }
    if (principal === null) {
      return c.json(
        { code: "UNAUTHORIZED", message: "Invalid bearer token" },
        401,
        { "WWW-Authenticate": "Bearer" },
      );
    }
    c.set("principal", principal);
    await next();
    return;
  };
}
