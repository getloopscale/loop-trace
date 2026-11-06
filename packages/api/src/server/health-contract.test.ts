// The canonical operational names, and why this repo already agreed with the reason (B-117).
//
// # The argument was already here
//
// `app.ts` says it plainly, next to the healthz pair: *"the same three questions at the same URLs
// — a deploy gate that has to learn per-service paths is a deploy gate nobody reuses."* That is
// the ecosystem contract's D5 argument, reached independently in this repository.
//
// What differed was the answer. This service picked `healthz`; the contract picked `health`,
// because measured across nine services the split was four to three and the `z` suffix is a
// Kubernetes-era convention that carries no meaning for someone calling a `/v1` API. So the
// canonical names are added and the existing ones stay — additive, as the contract's migration
// rule requires, because the deploy gate this repo built points at `healthz` today.
//
// # Why the document has to describe them
//
// `openapi.ts` excludes `/v1/healthz`, `/v1/healthz/ready` and `/v1/version` from the generated
// spec as "not part of the documented public data surface". For the admin routes next to them the
// exclusion is least-privilege and stays. For health and version it is not a control: both answer
// unauthenticated to anyone who asks, so omitting them from the document hides nothing and only
// stops the ecosystem contract checker — which reads the document and nothing else — from seeing
// that the service has an operational surface at all.

import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";

/**
 * `createApp` takes its dependencies POSITIONALLY, and `health` is the eighth parameter. Passing
 * an object with a `health` field lands on `repo` instead, so the app builds with no health deps
 * and readiness answers "ready" over a database nobody probed — a green test proving nothing.
 * Naming every skipped slot is verbose and is what keeps this honest.
 */
function app(dbOk = true) {
  const health = {
    version: "test",
    pingDb: async (): Promise<void> => {
      if (!dbOk) throw new Error("db down");
    },
  };
  return createApp(
    {} as never, // repo
    undefined, // webDistDir
    {}, // auth
    undefined, // evaluators
    undefined, // copilot
    undefined, // replay
    undefined, // experiment
    undefined, // ingest
    health,
  );
}

describe("the canonical operational surface", () => {
  it("test_canonical_liveness_is_served", async () => {
    const res = await app().request("/v1/health");
    expect(res.status, "/v1/health is the contract name for liveness").toBe(200);
  });

  it("test_canonical_readiness_is_served", async () => {
    const res = await app().request("/v1/health/ready");
    expect(res.status, "/v1/health/ready is the contract name for readiness").toBe(200);
  });

  it("test_canonical_readiness_fails_when_the_database_does", async () => {
    // Not an alias of liveness. A readiness route wired to the liveness handler answers "ready"
    // whenever the process is up — the failure the route exists to prevent, under the right name.
    const res = await app(false).request("/v1/health/ready");
    expect(res.status).toBe(503);
  });

  it("test_canonical_liveness_is_database_independent", async () => {
    // The property this repo already argued for: a DB blip that fails liveness gets a recoverable
    // process killed. Readiness is what says "alive but cannot serve".
    const res = await app(false).request("/v1/health");
    expect(res.status).toBe(200);
  });

  it("test_the_healthz_pair_still_answers", async () => {
    // The deploy gate points here today. Additive migration: removal is its own item.
    for (const path of ["/v1/healthz", "/v1/healthz/ready"]) {
      const res = await app().request(path);
      expect(res.status, `${path} stopped answering`).toBe(200);
    }
  });

  it("test_the_document_describes_the_operational_surface", async () => {
    // The contract checker reads the document and nothing else. Health and version answer
    // unauthenticated already, so omitting them hides nothing — it only makes the service look,
    // to the checker, like it has no operational surface.
    const doc = (await (await app().request("/openapi.json")).json()) as {
      paths?: Record<string, unknown>;
    };
    const paths = Object.keys(doc.paths ?? {});

    expect(paths).toContain("/v1/health");
    expect(paths).toContain("/v1/version");
  });

  it("test_the_admin_surface_stays_out_of_the_document", async () => {
    // The counterpart, and the reason this is not a blanket "document everything": the admin
    // key-lifecycle routes are kept out of the unauthenticated spec on least-privilege grounds.
    // Publishing mint/revoke to anonymous clients is reconnaissance exposure, and unlike health
    // those routes do NOT answer without a credential — the exclusion is a control, not obscurity.
    const doc = (await (await app().request("/openapi.json")).json()) as {
      paths?: Record<string, unknown>;
    };
    const admin = Object.keys(doc.paths ?? {}).filter((p) => p.startsWith("/v1/admin"));

    expect(admin, "admin routes leaked into the public spec").toEqual([]);
  });
});
