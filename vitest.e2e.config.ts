import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * E2E test config — exercises the full stack (API + Postgres) via docker compose.
 * globalSetup brings the stack up and applies migrations; tests hit the running
 * API over HTTP. Fails loudly if compose cannot start (no silent skip for e2e).
 */
export default defineConfig({
  resolve: {
    alias: {
      // M122: specific-before-base — the subpath alias MUST precede the bare
      // `@usetheo/lens-core` alias so vite's prefix matcher routes /infra correctly.
      "@usetheo/lens-core/infra": fileURLToPath(
        new URL("./packages/core/src/infrastructure/db/index.ts", import.meta.url),
      ),
      "@usetheo/lens-core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/e2e/**/*.e2e.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    globalSetup: ["tests/e2e/global-setup.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    globals: false,
  },
});
