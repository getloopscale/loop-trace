#!/usr/bin/env node
/**
 * Copy the Drizzle migrations (`.sql` + `meta/`) from the core package's `src`
 * into its compiled `dist` (M22). `tsc` only emits `.ts` → `.js`; it does NOT
 * copy SQL assets, so `migrateLatest` (which resolves `./migrations` relative to
 * the compiled module via `import.meta.url`) was silently frozen at the last
 * migration present in `dist` — a latent bug that meant a built/deployed server
 * never applied any migration added after the dist was first populated. Run this
 * after `tsc -b` so the built artifact migrates to HEAD.
 */
import { cp, rm, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = `${root}packages/core/src/infrastructure/db/migrations`;
const dist = `${root}packages/core/dist/infrastructure/db/migrations`;

if (!existsSync(src)) {
  console.error(`[copy-migrations] source missing: ${src}`);
  process.exit(1);
}
// dist may not exist yet if core was never built; create its parent.
await mkdir(dist.slice(0, dist.lastIndexOf("/")), { recursive: true });
await rm(dist, { recursive: true, force: true });
await cp(src, dist, { recursive: true });
console.log(`[copy-migrations] copied migrations → ${dist}`);
