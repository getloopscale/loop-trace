import { describe, it, expect } from "vitest";
import { scopeSatisfies } from "./scope-hierarchy.js";
import { BearerAuthVerifier } from "./bearer-verifier.js";
import { ApiKeyAuthVerifier, type AuthPool } from "./api-key-verifier.js";

describe("scopeSatisfies (M22)", () => {
  it("test_scope_satisfies_platform_admin_implies_admin_only", () => {
    // platform-admin implies admin (key lifecycle) but NEVER a data scope.
    expect(scopeSatisfies(["observability:platform-admin"], "observability:admin")).toBe(true);
    expect(scopeSatisfies(["observability:platform-admin"], "observability:write")).toBe(false);
    expect(scopeSatisfies(["observability:platform-admin"], "observability:read")).toBe(false);
    expect(scopeSatisfies(["observability:platform-admin"], "observability:delete")).toBe(false);
  });

  it("test_scope_satisfies_broker_key_passes_its_verbs", () => {
    const broker = ["observability:read", "observability:write", "observability:delete"];
    expect(scopeSatisfies(broker, "observability:read")).toBe(true);
    expect(scopeSatisfies(broker, "observability:write")).toBe(true);
    expect(scopeSatisfies(broker, "observability:delete")).toBe(true);
    expect(scopeSatisfies(broker, "observability:admin")).toBe(false);
  });

  it("test_scope_satisfies_empty_grants_nothing", () => {
    expect(scopeSatisfies([], "observability:read")).toBe(false);
  });
});

describe("BearerAuthVerifier (M22)", () => {
  it("test_bearer_verifier_length_guard_does_not_throw", async () => {
    const v = new BearerAuthVerifier("expected-secret");
    await expect(v.verify("short")).resolves.toBe(false); // different length, no RangeError
  });

  it("test_bearer_verifier_empty_sentinel_rejects_everything", async () => {
    const v = new BearerAuthVerifier("");
    expect(await v.verify("")).toBe(false);
    expect(await v.verify("anything")).toBe(false);
  });

  it("test_bearer_verifier_match_resolves_default_owner_principal", async () => {
    const v = new BearerAuthVerifier("s3cret");
    expect(await v.verify("s3cret")).toBe(true);
    const p = await v.resolvePrincipal("s3cret");
    expect(p).toEqual({
      workspaceId: "default",
      userId: "default-owner",
      role: "owner",
      scopes: ["observability:read", "observability:write", "observability:delete"],
    });
    expect(await v.resolvePrincipal("wrong")).toBeNull();
  });
});

describe("ApiKeyAuthVerifier (M22)", () => {
  function poolReturning(rows: unknown[]): AuthPool {
    return {
       
      query: async <T>() => ({ rows: rows as T[] }),
    };
  }

  it("test_api_key_verifier_bad_prefix_short_circuits_before_db", async () => {
    let queried = false;
    const pool: AuthPool = {
       
      query: async <T>() => {
        queried = true;
        return { rows: [] as T[] };
      },
    };
    const v = new ApiKeyAuthVerifier(pool);
    expect(await v.resolvePrincipal("nope_not_a_lens_key")).toBeNull();
    expect(queried).toBe(false); // never hit the DB
  });

  it("test_api_key_verifier_resolves_principal_from_row", async () => {
    const v = new ApiKeyAuthVerifier(
      poolReturning([
        {
          workspace_id: "ws-acme",
          user_id: "u-1",
          scopes: ["observability:read", "observability:write"],
          role: "admin",
        },
      ]),
    );
    const p = await v.resolvePrincipal("theo_live_abcdefghijklmnop");
    expect(p).toEqual({
      workspaceId: "ws-acme",
      userId: "u-1",
      role: "admin",
      scopes: ["observability:read", "observability:write"],
    });
  });

  it("test_api_key_verifier_revoked_or_unknown_resolves_null", async () => {
    const v = new ApiKeyAuthVerifier(poolReturning([])); // no active row
    expect(await v.resolvePrincipal("theo_live_abcdefghijklmnop")).toBeNull();
  });

  it("test_api_key_verifier_jsonb_string_scopes_parsed", async () => {
    const v = new ApiKeyAuthVerifier(
      poolReturning([
        {
          workspace_id: "ws-x",
          user_id: null,
          scopes: '["observability:read"]', // pg surfaced jsonb as a string
          role: null, // no membership → default-deny 'member'
        },
      ]),
    );
    const p = await v.resolvePrincipal("theo_live_abcdefghijklmnop");
    expect(p?.scopes).toEqual(["observability:read"]);
    expect(p?.role).toBe("member");
    expect(p?.userId).toBeNull();
  });
});
