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
    expect(await res.text()).toContain("looptrace ui");
  });

  it("test_mount_static_returns_404_for_missing_asset", async () => {
    const app = new Hono();
    mountStatic(app, FIXTURE_ROOT);
    // A missing asset under /assets/ must 404 — NOT be masked as index.html,
    // which would hide a broken build (EC-2).
    const res = await app.request("/assets/does-not-exist.js");
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('id="root"');
  });

  it("test_mount_static_falls_back_for_dotted_navigation_route", async () => {
    const app = new Hono();
    mountStatic(app, FIXTURE_ROOT);
    // A real client route whose param contains a dot (e.g. a model/tool name
    // like gpt-4.0 at /tools/:toolName) MUST serve index.html, not 404 (F-fe-1).
    const res = await app.request("/tools/gpt-4.0");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="root"');
  });

  it("test_mount_static_is_noop_when_dist_absent", async () => {
    const app = new Hono();
    mountStatic(app, "packages/api/src/server/__fixtures__/no-such-dist");
    // Fail-soft: no static route mounted, so / is unhandled → 404 (API-only mode).
    const res = await app.request("/");
    expect(res.status).toBe(404);
  });

  it("test_mount_static_is_noop_when_index_html_missing", async () => {
    const app = new Hono();
    // A dist dir that exists but lacks index.html must NOT 500 on navigation —
    // fail-soft to API-only mode (F-test-5).
    mountStatic(app, "packages/api/src/server/__fixtures__/web-dist-no-index");
    const res = await app.request("/");
    expect(res.status).toBe(404);
  });
});
