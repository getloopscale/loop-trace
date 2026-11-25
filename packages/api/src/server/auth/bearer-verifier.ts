/**
 * BearerAuthVerifier — the env-key single-tenant bridge (M22). Ported from the
 * reference capability `loopmem` (`auth/bearer-verifier.ts`) with a
 * `THEMEMORY_API_KEY` → `LOOPTRACE_API_KEY` env rename + `memory:` → `lens:` scope
 * swap. See `data-plane/README.md § 3.1`.
 *
 * Fail-closed sentinel (EC-1): empty/whitespace env value ⇒ auth required, no
 * token accepts; only `undefined` env ⇒ auth disabled. Constant-time compare with
 * a length-guard BEFORE `timingSafeEqual` (EC-4 — else different-length Buffers
 * throw a RangeError → 500 instead of a clean 401).
 */
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";

import {
  type AuthVerifier,
  type Principal,
  DEFAULT_OWNER_USER_ID,
  DEFAULT_WORKSPACE_ID,
} from "@looptrace/core";

const LOOPTRACE_API_KEY_ENV = "LOOPTRACE_API_KEY";

/**
 * Resolve the configured API key from the environment with fail-closed sentinel
 * semantics: `undefined` ⇒ auth disabled; empty/whitespace ⇒ `''` sentinel
 * (auth required, nothing accepts); non-empty ⇒ verbatim (no trim).
 */
export function readApiKey(): string | undefined {
  const raw = process.env[LOOPTRACE_API_KEY_ENV];
  if (raw === undefined) return undefined;
  if (raw.trim() === "") return "";
  return raw;
}

export class BearerAuthVerifier implements AuthVerifier {
  readonly #expectedToken: string;

  constructor(expectedToken: string) {
    this.#expectedToken = expectedToken;
  }

   
  async verify(token: string): Promise<boolean> {
    if (token.length !== this.#expectedToken.length) return false;
    if (this.#expectedToken === "") return false;
    const a = Buffer.from(token, "utf8");
    const b = Buffer.from(this.#expectedToken, "utf8");
    return timingSafeEqual(a, b);
  }

  /**
   * The legacy env-key credential bridges to the `default` workspace, acting as
   * the seeded `default-owner` with the `owner` role (so single-tenant OSS
   * deployments retain full capability); a non-match resolves to `null` → 401.
   */
  async resolvePrincipal(token: string): Promise<Principal | null> {
    const ok = await this.verify(token);
    if (!ok) return null;
    return {
      workspaceId: DEFAULT_WORKSPACE_ID,
      userId: DEFAULT_OWNER_USER_ID,
      role: "owner",
      scopes: ["observability:read", "observability:write", "observability:delete"],
    };
  }
}
