/**
 * Principal + Workspace — the multi-tenant workspace-isolation domain types
 * (M22). Ported from the reference data-plane capability `loopmem`
 * (`packages/core/src/domain/principal.ts`) with a mechanical `memory:` → `lens:`
 * scope swap — see `data-plane/README.md § 3.1` (the contract this capability copies).
 *
 * A {@link Principal} is what an {@link AuthVerifier} resolves FROM a credential:
 * it answers "whose key is this?" (the tenant + its granted scopes), not merely
 * "is this key valid?". Every authenticated request carries a Principal; every
 * row belongs to the Principal's {@link Workspace}; every query is scoped by
 * `workspaceId`. `workspaceId == tenant_id` — the data plane does NOT know about
 * accounts (data-plane/CLAUDE.md inviolable invariant 2).
 */

/** The tenant boundary. Every row belongs to exactly one workspace. */
export interface Workspace {
  /** Stable identifier. The seeded fallback uses {@link DEFAULT_WORKSPACE_ID}. */
  readonly id: string;
  /** Human-facing label. */
  readonly name: string;
  /** When the workspace was created. */
  readonly createdAt: Date;
}

/**
 * A user's privilege WITHIN a workspace (`workspace_users.role`). Orthogonal to
 * {@link Principal.scopes} (the key's capability): `role` gates MEMBERSHIP
 * management (mint keys, add/remove members), `scopes` gates data CAPABILITY
 * (read/write/delete/admin). A credential with no membership row resolves to the
 * least-privileged `'member'` (default-deny).
 */
export type WorkspaceRole = "owner" | "admin" | "member";

/** Ordinal privilege ranking — higher is more privileged. */
const ROLE_RANK: Record<WorkspaceRole, number> = {
  member: 0,
  admin: 1,
  owner: 2,
};

/**
 * True when `role` is at least as privileged as `min`. `owner` satisfies every
 * minimum; `member` satisfies only `member`. The gate `requireRole(min)` and the
 * key-mint anti-escalation guard both consult.
 */
export function roleSatisfies(role: WorkspaceRole, min: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/**
 * Resolved from a credential by {@link AuthVerifier.resolvePrincipal}. Carries
 * the tenant (`workspaceId`), the member the key acts as (`userId`, null for
 * legacy keys), that member's workspace `role`, and the key's capability set
 * (`scopes`, mirroring the `looptrace_api_keys.scopes` JSONB shape). `workspaceId` is
 * injected server-side into every scoped query and MUST NOT be taken from the
 * request body (data-plane/CLAUDE.md invariant 3).
 */
export interface Principal {
  /** The tenant the credential belongs to. */
  readonly workspaceId: string;
  /** The member the credential acts as; `null` for a legacy key with no member. */
  readonly userId: string | null;
  /** The member's role in this workspace (default-deny resolves to `'member'`). */
  readonly role: WorkspaceRole;
  /** Granted capability scopes (e.g. `observability:read`, `observability:write`, `observability:delete`). */
  readonly scopes: readonly string[];
}

/**
 * Resolves a {@link Principal} from a bearer credential (and a legacy boolean
 * `verify` for the migration window). Implemented by the env-key bridge
 * (`BearerAuthVerifier`) and the multi-tenant `ApiKeyAuthVerifier`.
 */
export interface AuthVerifier {
  resolvePrincipal(token: string): Promise<Principal | null>;
  /** Legacy boolean fallback (true iff the token resolves to a Principal). */
  verify(token: string): Promise<boolean>;
}

/**
 * Stable id of the workspace every legacy / no-credential request collapses to.
 * A FIXED literal (not a random UUID) so the env-key bridge + the no-credential
 * path resolve it without a lookup race and the seed migration is idempotent.
 */
export const DEFAULT_WORKSPACE_ID = "default";

/**
 * Stable id of the seeded user every legacy / no-credential request acts as —
 * the owner of the {@link DEFAULT_WORKSPACE_ID} workspace.
 */
export const DEFAULT_OWNER_USER_ID = "default-owner";

/**
 * Build the backward-compatible boolean `verify(token)` from a verifier that
 * implements {@link AuthVerifier.resolvePrincipal}: a token is "valid" iff it
 * resolves to a non-null Principal.
 */
export function makeVerifyShim(
  verifier: { resolvePrincipal(token: string): Promise<Principal | null> },
): (token: string) => Promise<boolean> {
  return async (token: string): Promise<boolean> =>
    (await verifier.resolvePrincipal(token)) !== null;
}
