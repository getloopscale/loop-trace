/**
 * ApiKeyAuthVerifier — the multi-tenant `theo_api_keys` verifier (M22). Ported
 * from the reference capability `theo-memory` (`auth/api-key-verifier.ts`) — see
 * `theo-data/README.md § 3.1`. The `theo_api_keys` table is generic (scopes is
 * jsonb), so it holds `lens:*` scopes with no shape change.
 *
 * Stripe-shape: (1) `theo_live_` prefix + length check BEFORE hashing;
 * (2) single-pass SHA-256 of the raw token (256-bit entropy → no bcrypt);
 * (3) SELECT the Principal filtered by active key (`revoked_at IS NULL` AND
 * `expires_at` NULL-or-future) — a revoked/expired key resolves to no row → null
 * → 401; (4) fire-and-forget `last_used_at` touch (never blocks the auth path).
 * The raw token NEVER appears in SQL — only its parameterized hash.
 */
import { createHash } from "node:crypto";

import {
  type AuthVerifier,
  type Principal,
  type WorkspaceRole,
} from "@usetheo/lens-core";

/**
 * Minimal pool surface — DIP-clean. Production wires `pg.Pool` (satisfies it
 * verbatim); tests pass an in-memory stub. Kept in the api layer (infra concern),
 * not core domain, per `rules/architecture.md § 2`.
 */
export interface AuthPoolClient {
  query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }>;
  release(): void;
}

export interface AuthPool {
  query<T>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }>;
  /** Pin a single connection for transactional operations. */
  connect?(): Promise<AuthPoolClient>;
}

const PREFIX = "theo_live_";

/** Boolean liveness — parameterized, single-tenant-isolated (`tenant_id='self'`). */
const SELECT_ACTIVE_BY_HASH_SQL = `\
SELECT id FROM theo_api_keys
 WHERE key_hash = $1
   AND revoked_at IS NULL
   AND (expires_at IS NULL OR expires_at > NOW())
   AND tenant_id = 'self'
 LIMIT 1`;

/**
 * Principal resolver — the WHERE predicate is VERBATIM the liveness one above, so
 * a revoked/expired key resolves to no row → null → 401. LEFT JOIN
 * `workspace_users` resolves the member's role (NULL → defaulted to 'member').
 */
const SELECT_PRINCIPAL_BY_HASH_SQL = `\
SELECT k.workspace_id, k.user_id, k.scopes, m.role
 FROM theo_api_keys k
 LEFT JOIN workspace_users m
   ON m.workspace_id = k.workspace_id AND m.user_id = k.user_id
 WHERE k.key_hash = $1
   AND k.revoked_at IS NULL
   AND (k.expires_at IS NULL OR k.expires_at > NOW())
   AND k.tenant_id = 'self'
 LIMIT 1`;

const UPDATE_LAST_USED_SQL = `UPDATE theo_api_keys SET last_used_at = NOW() WHERE key_hash = $1`;

export class ApiKeyAuthVerifier implements AuthVerifier {
  readonly #pool: AuthPool;

  constructor(pool: AuthPool) {
    this.#pool = pool;
  }

  async verify(token: string): Promise<boolean> {
    if (token.length <= PREFIX.length) return false;
    if (!token.startsWith(PREFIX)) return false;

    const hash = createHash("sha256").update(token).digest("hex");
    const { rows } = await this.#pool.query<{ id: string }>(
      SELECT_ACTIVE_BY_HASH_SQL,
      [hash],
    );
    if (rows.length === 0) return false;

    void this.#touchLastUsed(hash);
    return true;
  }

  async resolvePrincipal(token: string): Promise<Principal | null> {
    if (token.length <= PREFIX.length) return null;
    if (!token.startsWith(PREFIX)) return null;

    const hash = createHash("sha256").update(token).digest("hex");
    const { rows } = await this.#pool.query<{
      workspace_id: string;
      user_id: string | null;
      scopes: unknown;
      role: string | null;
    }>(SELECT_PRINCIPAL_BY_HASH_SQL, [hash]);
    const row = rows[0];
    if (row === undefined) return null;

    // scopes is jsonb; pg may surface it parsed OR as a string — handle both.
    let scopes: readonly string[] = [];
    const raw: unknown =
      typeof row.scopes === "string" ? JSON.parse(row.scopes) : row.scopes;
    if (Array.isArray(raw)) {
      scopes = raw.filter((s): s is string => typeof s === "string");
    }

    // Default-deny: only the three enum values are trusted; else 'member'.
    const role: WorkspaceRole =
      row.role === "owner" || row.role === "admin" || row.role === "member"
        ? row.role
        : "member";

    void this.#touchLastUsed(hash);
    return { workspaceId: row.workspace_id, userId: row.user_id, role, scopes };
  }

  #touchLastUsed(hash: string): Promise<void> {
    return this.#pool
      .query(UPDATE_LAST_USED_SQL, [hash])
      .then(() => undefined)
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
         
        console.warn(`[theo-lens] last_used_at update failed: ${msg}`);
      });
  }
}
