import { describe, it, expect } from "vitest";
import type { AuthVerifier, Principal, SpanRepository } from "@usetheo/lens-core";
import { createApp } from "./app.js";

/**
 * M22 scope×verb contract matrix — the `#77`-class proof: every credential class
 * against a representative route of each verb → the expected status. The decisive
 * row is `platform-admin-only`: it implies ONLY `lens:admin`, so it is 403 on EVERY
 * data verb (the data-plane half of CWE-441). Mirrors theo-memory's
 * `scope-verb-matrix.test.ts`.
 */

const TOKENS: Record<string, string[]> = {
  none: [], // (sent as no-credential below)
  read: ["lens:read"],
  write: ["lens:write"],
  delete: ["lens:delete"],
  full: ["lens:read", "lens:write", "lens:delete"],
  platformAdmin: ["lens:platform-admin"],
};

function verifier(): AuthVerifier {
  const map: Record<string, Principal> = {};
  for (const [tok, scopes] of Object.entries(TOKENS)) {
    if (tok === "none") continue;
    map[tok] = { workspaceId: "ws", userId: "u", role: "member", scopes };
  }
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    resolvePrincipal: async (t) => map[t] ?? null,
    // eslint-disable-next-line @typescript-eslint/require-await
    verify: async (t) => map[t] !== undefined,
  };
}

const repo = {
  save: async () => undefined,
  listTraces: async () => ({ traces: [] }),
  getTraceTree: async () => null,
  removeTag: async () => undefined,
  listTags: async () => [],
} as unknown as SpanRepository;

const app = createApp(repo, undefined, { verifier: verifier(), requireCredential: true });

const OTLP = JSON.stringify({
  resourceSpans: [{ scopeSpans: [{ spans: [] }] }],
});

/** One representative route per verb. */
const ROUTES = {
  write: () =>
    new Request("http://x/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: OTLP,
    }),
  read: () => new Request("http://x/v1/traces"),
  delete: () =>
    new Request("http://x/v1/traces/t1/tags?tag=x", { method: "DELETE" }),
} as const;

// expected[tokenClass][verb] = status (401 no-cred, 403 wrong-scope, 200 allowed).
const EXPECTED: Record<string, Record<keyof typeof ROUTES, number>> = {
  none: { write: 401, read: 401, delete: 401 },
  read: { write: 403, read: 200, delete: 403 },
  write: { write: 200, read: 403, delete: 403 },
  delete: { write: 403, read: 403, delete: 200 },
  full: { write: 200, read: 200, delete: 200 },
  // platform-admin implies ONLY lens:admin → 403 on every DATA verb.
  platformAdmin: { write: 403, read: 403, delete: 403 },
};

describe("M22 scope×verb matrix", () => {
  for (const [tokenClass, perVerb] of Object.entries(EXPECTED)) {
    for (const [verb, status] of Object.entries(perVerb) as [
      keyof typeof ROUTES,
      number,
    ][]) {
      it(`token=${tokenClass} verb=${verb} → ${status}`, async () => {
        const req = ROUTES[verb]();
        if (tokenClass !== "none") {
          req.headers.set("authorization", `Bearer ${tokenClass}`);
        }
        const res = await app.request(req);
        expect(res.status).toBe(status);
      });
    }
  }
});
