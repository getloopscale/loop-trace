import { describe, it, expect } from "vitest";
import type { AuthVerifier, Principal, SpanRepository } from "@usetheo/lens-core";
import { createApp } from "./app.js";

/** A fake verifier mapping a token → a Principal (M22 route-auth tests). */
function verifierFor(map: Record<string, Principal>): AuthVerifier {
  return {
     
    resolvePrincipal: async (token) => map[token] ?? null,
     
    verify: async (token) => map[token] !== undefined,
  };
}

function principal(scopes: string[], workspaceId = "ws-x"): Principal {
  return { workspaceId, userId: "u", role: "member", scopes };
}

/** A repo stub that records the workspaceId `save` was called with. */
function repoStub(): { repo: SpanRepository; lastSaveWorkspace: () => string | undefined } {
  let ws: string | undefined;
  const repo = {
    save: async (_spans: unknown[], workspaceId?: string) => {
      ws = workspaceId;
    },
    listTraces: async () => ({ traces: [] }),
  } as unknown as SpanRepository;
  return { repo, lastSaveWorkspace: () => ws };
}

const OTLP = {
  resourceSpans: [
    {
      scopeSpans: [
        {
          spans: [
            {
              spanId: "a1",
              traceId: "t1",
              name: "op",
              startTimeUnixNano: "1700000000000000000",
              endTimeUnixNano: "1700000000100000000",
            },
          ],
        },
      ],
    },
  ],
};

function ingest(token?: string): Request {
  return new Request("http://x/v1/traces", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(OTLP),
  });
}

describe("M22 route auth (per-verb scope)", () => {
  it("test_ingest_requires_write_scope", async () => {
    const { repo } = repoStub();
    const app = createApp(repo, undefined, {
      verifier: verifierFor({
        ro: principal(["observability:read"]),
        rw: principal(["observability:read", "observability:write"]),
      }),
      requireCredential: true,
    });
    // read-only key → 403 INSUFFICIENT_SCOPE on ingest (a write verb)
    expect((await app.request(ingest("ro"))).status).toBe(403);
    // write key → 200
    expect((await app.request(ingest("rw"))).status).toBe(200);
  });

  it("test_platform_admin_only_key_403_on_every_data_verb", async () => {
    const { repo } = repoStub();
    const app = createApp(repo, undefined, {
      verifier: verifierFor({ pa: principal(["observability:platform-admin"]) }),
      requireCredential: true,
    });
    // platform-admin implies ONLY observability:admin, never a data scope → 403 on write AND read
    expect((await app.request(ingest("pa"))).status).toBe(403);
    const read = new Request("http://x/v1/traces", {
      headers: { authorization: "Bearer pa" },
    });
    expect((await app.request(read)).status).toBe(403);
  });

  it("test_fail_closed_missing_credential_401_in_multitenant", async () => {
    const { repo } = repoStub();
    const app = createApp(repo, undefined, {
      verifier: verifierFor({ rw: principal(["observability:read", "observability:write"]) }),
      requireCredential: true,
    });
    expect((await app.request(ingest(undefined))).status).toBe(401); // no key
    expect((await app.request(ingest("bogus"))).status).toBe(401); // unknown key
  });

  it("test_ingest_binds_principal_workspace_not_body", async () => {
    const { repo, lastSaveWorkspace } = repoStub();
    const app = createApp(repo, undefined, {
      verifier: verifierFor({ rw: principal(["observability:write"], "ws-acme") }),
      requireCredential: true,
    });
    const res = await app.request(ingest("rw"));
    expect(res.status).toBe(200);
    expect(lastSaveWorkspace()).toBe("ws-acme"); // from the Principal, not the body
  });

  it("test_single_tenant_no_verifier_allows_all_verbs", async () => {
    // No verifier + not requireCredential → DEFAULT_PRINCIPAL (full data scopes).
    const { repo } = repoStub();
    const app = createApp(repo);
    expect((await app.request(ingest(undefined))).status).toBe(200);
  });

  it("test_fail_closed_503_on_auth_backend_throw_no_privileged_default", async () => {
    // Invariant 5 (the 503 half): when the auth backend throws (e.g. DB down), the
    // request fails with 503 — NEVER served via a privileged default. F3 regression.
    const { repo, lastSaveWorkspace } = repoStub();
    const throwing: AuthVerifier = {

      resolvePrincipal: async () => {
        throw new Error("auth db down");
      },

      verify: async () => {
        throw new Error("auth db down");
      },
    };
    const app = createApp(repo, undefined, {
      verifier: throwing,
      requireCredential: true,
    });
    const res = await app.request(ingest("any"));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("SERVICE_UNAVAILABLE");
    // The handler never ran → no privileged default leaked the write through.
    expect(lastSaveWorkspace()).toBeUndefined();
  });

  it("test_every_data_route_requires_credential_in_multitenant", async () => {
    // LENS-AUTH-1 mechanical guard: with requireCredential and NO token, every data
    // route (one per resource family + the path-param variants) must fail closed (401),
    // proving bearerAuth precedes them and getPrincipal's default never authorizes.
    const { repo } = repoStub();
    const app = createApp(repo, undefined, {
      verifier: verifierFor({ rw: principal(["observability:read", "observability:write", "observability:delete"]) }),
      requireCredential: true,
    });
    const dataRoutes = [
      "GET /v1/traces",
      "GET /v1/spans/x",
      "GET /v1/traces/x",
      "GET /v1/traces/x/cost",
      "GET /v1/agents",
      "GET /v1/analytics/tools",
      "GET /v1/analytics/tools/x/traces",
      "GET /v1/analytics/cost",
      "GET /v1/metrics/north-star",
      "GET /v1/metrics/observability",
      "GET /v1/metrics/evaluators",
      "GET /v1/sessions",
      "GET /v1/sessions/x",
      "GET /v1/traces/x/tags",
      "GET /v1/traces/x/annotations",
      "GET /v1/datasets",
      "GET /v1/datasets/x",
    ];
    for (const route of dataRoutes) {
      const [method, path] = route.split(" ");
      const res = await app.request(
        new Request(`http://x${path}`, { method }),
      );
      expect(`${route} → ${res.status}`).toBe(`${route} → 401`);
    }
  });
});
