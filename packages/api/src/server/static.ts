import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";

/**
 * Mount same-origin static serving of the built web bundle onto `app`.
 *
 * `relativeRoot` MUST be relative to the process CWD — `serveStatic`'s `root`
 * does not support absolute paths (EC-1). The server is launched from the app
 * root (Docker `WORKDIR /app`, CMD `node packages/api/dist/server/index.js`),
 * so e.g. `packages/web/dist` resolves to `/app/packages/web/dist`.
 *
 * Behavior:
 *  - `/assets/*` is served from the bundle (Vite emits hashed JS/CSS there). A
 *    missing asset returns 404 — never masked as index.html, so a broken build
 *    is not hidden (EC-2).
 *  - Every other GET serves `index.html` so the client-side router (React
 *    Router) resolves the route (SPA fallback). This is path-agnostic, so a
 *    client route whose param contains a dot (e.g. `/tools/gpt-4.0`) still
 *    falls back correctly (F-fe-1) — we never guess "asset vs route" from the
 *    presence of a dot.
 *  - `index.html` is read once at mount (immutable for the image lifetime).
 *  - When the bundle (or its `index.html`) is absent (dev without a web build),
 *    this is a no-op (fail-soft): the API still serves /v1/* and logs that the
 *    UI is not mounted (phoenix `app.py:1057-1063`).
 *
 * The `/assets/*` middleware is scoped, so /v1/* API requests never pay a
 * filesystem probe. Callers SHOULD still invoke this AFTER registering all
 * /v1/* routes; the catch-all SPA GET would otherwise have to be ordered
 * explicitly anyway.
 */
export function mountStatic(app: Hono, relativeRoot: string): void {
  const absoluteRoot = resolve(process.cwd(), relativeRoot);
  const indexPath = join(absoluteRoot, "index.html");
  if (!existsSync(indexPath)) {
    console.error(
      JSON.stringify({
        level: "warn",
        msg: "ui_not_mounted",
        reason: "index.html not found",
        root: relativeRoot,
      }),
    );
    return;
  }

  const indexHtml = readFileSync(indexPath, "utf8");

  // Hashed assets; on miss, serveStatic calls next() → the 404 below fires.
  app.use("/assets/*", serveStatic({ root: relativeRoot }));
  app.get("/assets/*", (c) => c.text("Not Found", 404));

  // SPA fallback: any non-asset, non-/v1 navigation GET serves index.html.
  app.get("/*", (c) => c.html(indexHtml));
}
