import { describe, expect, it } from "vitest";
import { Hono } from "hono";

import { mountStatic } from "./static.js";

/**
 * Contract tests for the static + SPA-fallback mount. The fixture dist lives at
 * a CWD-relative path because `@hono/node-server/serve-static` does NOT support
 * absolute roots (EC-1) — the path is relative to the repo root where vitest runs.
 */
const FIXTURE_ROOT = "packages/api/src/server/__fixtures__/web-dist";

describe("mountStatic", () => {
  it("test_mount_static_serves_index_at_root", async () => {
    const app = new Hono();
    mountStatic(app, FIXTURE_ROOT);
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="root"');
  });

  it("test_mount_static_falls_back_to_index_for_spa_route", async () => {
    const app = new Hono();
    mountStatic(app, FIXTURE_ROOT);
    // No such file — a client-side route. SPA fallback returns index.html.
    const res = await app.request("/traces/abc");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('id="root"');
  });

  it("test_mount_static_serves_hashed_asset", async () => {
    const app = new Hono();
    mountStatic(app, FIXTURE_ROOT);
    const res = await app.request("/assets/app.js");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("theo lens ui");
  });

  it("test_mount_static_returns_404_for_missing_asset", async () => {
    const app = new Hono();
    mountStatic(app, FIXTURE_ROOT);
    // A missing asset (has a file extension) must 404 — NOT be masked as
    // index.html, which would hide a broken build (EC-2).
    const res = await app.request("/assets/does-not-exist.js");
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('id="root"');
  });

  it("test_mount_static_is_noop_when_dist_absent", async () => {
    const app = new Hono();
    mountStatic(app, "packages/api/src/server/__fixtures__/no-such-dist");
    // Fail-soft: no static route mounted, so / is unhandled → 404 (API-only mode).
    const res = await app.request("/");
    expect(res.status).toBe(404);
  });
});
