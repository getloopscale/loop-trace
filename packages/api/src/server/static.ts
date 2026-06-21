import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
 *  - Real files under the root are served (hashed assets, index.html at `/`).
 *  - A navigation GET that matched no file falls back to `index.html` so the
 *    client-side router (React Router) resolves the route (SPA fallback).
 *  - A *missing asset* (path whose last segment has a file extension) returns
 *    404 — never masked as index.html, so a broken build is not hidden (EC-2).
 *  - When `relativeRoot` does not exist (dev without a web build), this is a
 *    no-op (fail-soft): the API still serves /v1/* and logs that the UI is not
 *    mounted (phoenix `app.py:1057-1063`).
 *
 * Callers MUST invoke this AFTER registering all /v1/* routes so the API is
 * never shadowed by the catch-all static middleware.
 */
export function mountStatic(app: Hono, relativeRoot: string): void {
  const absoluteRoot = resolve(process.cwd(), relativeRoot);
  if (!existsSync(absoluteRoot)) {
    console.error(
      JSON.stringify({
        level: "warn",
        msg: "ui_not_mounted",
        reason: "web dist not found",
        root: relativeRoot,
      }),
    );
    return;
  }

  // Serve real files; on miss, serveStatic calls next() → the SPA fallback runs.
  app.use("/*", serveStatic({ root: relativeRoot }));

  app.get("/*", async (c) => {
    const lastSegment = c.req.path.split("/").pop() ?? "";
    // A missing asset (has a file extension) must not be masked as index.html.
    if (lastSegment.includes(".")) {
      return c.text("Not Found", 404);
    }
    const html = await readFile(join(absoluteRoot, "index.html"), "utf8");
    return c.html(html);
  });
}
