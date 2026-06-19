import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Integration test config — runs *.integration.test.ts against a real Postgres
 * (postgres:16-alpine via docker-compose). Gated by THEOLENS_PG_URI: when absent,
 * the test files self-skip via `describe.skip` (see drizzle-span-repository test).
 * Longer timeout for DB setup; fileParallelism off to avoid TRUNCATE races.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@usetheo/lens-core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/**/src/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    globals: false,
  },
});
