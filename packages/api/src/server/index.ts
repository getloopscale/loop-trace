import { pathToFileURL } from "node:url";

import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { createSpanRepository, migrateLatest } from "@usetheo/lens-core";
import type pg from "pg";

import { createApp } from "./app.js";

/**
 * Default CWD-relative location of the built web bundle. The server is launched
 * from the app root (Docker `WORKDIR /app`, CMD `node packages/api/dist/server/index.js`),
 * so this resolves to `/app/packages/web/dist`. `serveStatic` rejects absolute
 * roots (EC-1), so this MUST stay CWD-relative.
 */
const DEFAULT_WEB_DIST = "packages/web/dist";

/**
 * Migrate-then-wire (D2): apply the committed migrations to the pool BEFORE the
 * app accepts traffic, then build the app serving the UI same-origin. Returns
 * the app + pool so the caller serves and (in tests) closes the pool. Rejects
 * loud on migration failure — a stack that cannot ingest must not come up.
 */
export async function bootstrap(
  uri: string,
  webDistDir: string = DEFAULT_WEB_DIST,
): Promise<{ app: Hono; pool: pg.Pool }> {
  const { repo, pool } = createSpanRepository(uri);
  await migrateLatest(pool);
  const app = createApp(repo, webDistDir);
  return { app, pool };
}

/**
 * Composition root: read config, migrate on boot, wire the UI-serving app, and
 * serve. Fails loud (structured log + non-zero exit, Rule 8) on missing config
 * or migration failure.
 */
export async function main(): Promise<void> {
  const uri = process.env["THEOLENS_PG_URI"];
  if (!uri) {
    console.error(
      JSON.stringify({ level: "error", msg: "THEOLENS_PG_URI is required" }),
    );
    process.exit(1);
    return;
  }

  const webDistDir = process.env["THEOLENS_WEB_DIST"] ?? DEFAULT_WEB_DIST;

  let app: Hono;
  try {
    console.error(JSON.stringify({ level: "info", msg: "migrating" }));
    ({ app } = await bootstrap(uri, webDistDir));
  } catch (err) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "boot migration failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exit(1);
    return;
  }

  const port = Number(process.env["THEOLENS_PORT"] ?? 4318);
  serve({ fetch: app.fetch, port });
  console.error(JSON.stringify({ level: "info", msg: "listening", port }));
}

// Run only when executed as the entry point — importing this module (tests)
// must NOT trigger main().
const invokedAsEntry =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsEntry) {
  void main();
}
