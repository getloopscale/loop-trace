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
        ro: principal(["lens:read"]),
        rw: principal(["lens:read", "lens:write"]),
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
      verifier: verifierFor({ pa: principal(["lens:platform-admin"]) }),
      requireCredential: true,
    });
    // platform-admin implies ONLY lens:admin, never a data scope → 403 on write AND read
    expect((await app.request(ingest("pa"))).status).toBe(403);
    const read = new Request("http://x/v1/traces", {
      headers: { authorization: "Bearer pa" },
    });
    expect((await app.request(read)).status).toBe(403);
  });

  it("test_fail_closed_missing_credential_401_in_multitenant", async () => {
    const { repo } = repoStub();
    const app = createApp(repo, undefined, {
      verifier: verifierFor({ rw: principal(["lens:read", "lens:write"]) }),
      requireCredential: true,
    });
    expect((await app.request(ingest(undefined))).status).toBe(401); // no key
    expect((await app.request(ingest("bogus"))).status).toBe(401); // unknown key
  });

  it("test_ingest_binds_principal_workspace_not_body", async () => {
    const { repo, lastSaveWorkspace } = repoStub();
    const app = createApp(repo, undefined, {
      verifier: verifierFor({ rw: principal(["lens:write"], "ws-acme") }),
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
});
