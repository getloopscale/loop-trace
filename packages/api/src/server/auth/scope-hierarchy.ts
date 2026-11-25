/**
 * Scope hierarchy — implication between API-key scopes (M22). Ported from the
 * reference capability `loopmem` (`auth/scope-hierarchy.ts`) with a
 * `memory:` → `lens:` swap — see `data-plane/README.md § 3.3`.
 *
 * The only implication is `observability:platform-admin ⊇ observability:admin` — the platform
 * credential the loopzero-cloud gateway uses to provision per-tenant keys must reach
 * the `observability:admin`-gated key-lifecycle routes without ALSO carrying a separate
 * `observability:admin` grant. Least privilege (NIST AC-6): `platform-admin` implies ONLY
 * `admin`, NEVER a data scope — so the gateway minting key is `403` on every data
 * verb (the data-plane half of CWE-441).
 */

/** Implication edges: key = granted scope, value = scopes it additionally satisfies. */
const SCOPE_IMPLIES: Readonly<Record<string, readonly string[]>> = {
  "observability:platform-admin": ["observability:admin"],
};

/**
 * Resolve whether a key's `granted` scope set satisfies the `required` scope,
 * honoring {@link SCOPE_IMPLIES}. Exact membership always satisfies; an implied
 * scope satisfies too. Pure + allocation-light (no Set for the tiny inputs).
 */
export function scopeSatisfies(
  granted: readonly string[],
  required: string,
): boolean {
  if (granted.includes(required)) return true;
  for (const g of granted) {
    if (SCOPE_IMPLIES[g]?.includes(required) === true) return true;
  }
  return false;
}
