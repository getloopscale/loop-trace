import { describe, expect, it } from "vitest";
import { createApp, type HealthApiDeps } from "./app.js";
import type { Span, SpanRepository } from "@looptrace/core";

/** Minimal repo stub — these probes never touch it; it exists only to satisfy the signature. */
class NoopRepo implements SpanRepository {
  async save(_spans: Span[]): Promise<void> {}
  async listTraces(): Promise<never[]> { return []; }
  async getTrace(): Promise<null> { return null; }
}

/**
 * CD pipeline playbook — the three probes a deploy gate depends on.
 *
 * `/v1/healthz` is liveness and must NEVER touch the database: a DB blip that fails liveness
 * gets a recoverable process killed. `/v1/healthz/ready` is the opposite — it exists precisely
 * to report "alive but cannot serve", so a load balancer drains instead of erroring.
 *
 * `/v1/version` is what makes a deploy verifiable. Without it, "did the new code go out?" is
 * answered by looking at a log, which is not an answer a script can gate on.
 */
describe("CD probes (playbook Phase 5)", () => {
  const make = (health?: HealthApiDeps, requireCredential = false) =>
    createApp(new NoopRepo() as never, undefined, { requireCredential },
      undefined, undefined, undefined, undefined, undefined, health);
  const app = () => make();

  it("test_healthz_is_liveness_and_never_touches_the_db", async () => {
    // No health deps wired at all — liveness must still be 200. A liveness probe that depends on
    // anything is not a liveness probe.
    const res = await app().request("/v1/healthz");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("ok");
  });

  it("test_ready_reports_503_when_the_db_probe_fails", async () => {
    const withBadDb = make({ pingDb: () => Promise.reject(new Error("db down")) });
    const res = await withBadDb.request("/v1/healthz/ready");
    expect(res.status).toBe(503);
  });

  it("test_ready_is_200_when_the_db_answers", async () => {
    const withDb = make({ pingDb: () => Promise.resolve() });
    expect((await withDb.request("/v1/healthz/ready")).status).toBe(200);
  });

  it("test_version_carries_the_git_sha_the_deploy_gate_compares", async () => {
    // The deploy script gates on the OCI image label, but /v1/version is what a human reads to
    // answer "what is running right now". A version endpoint without a sha cannot answer it.
    const res = await app().request("/v1/version");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    for (const key of ["name", "version", "git_sha", "built_at", "node"]) {
      expect(body, `missing ${key}`).toHaveProperty(key);
    }
    expect(body["name"]).toBe("looptrace");
  });

  it("test_the_probes_are_unauthenticated", async () => {
    // A deploy gate runs before any credential exists on the box. A probe behind auth cannot gate.
    const gated = make(undefined, true);
    for (const p of ["/v1/healthz", "/v1/healthz/ready", "/v1/version"]) {
      expect((await gated.request(p)).status, `${p} must not require a bearer`).not.toBe(401);
    }
  });

  it("test_the_legacy_probe_paths_are_gone", async () => {
    // Migrated deliberately (not aliased): the only in-repo consumer, the post-Cleanroom seed
    // script, moves in the same commit. Asserting their absence keeps the migration honest —
    // a half-migration that leaves both is the mixed vocabulary M136 spent a milestone removing.
    for (const p of ["/health", "/ready", "/version"]) {
      expect((await app().request(p)).status, `${p} should be gone`).toBe(404);
    }
  });
});
