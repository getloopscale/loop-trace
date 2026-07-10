import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Integration test config — runs *.integration.test.ts against a real Postgres.
 * M97 (B-M4): a Testcontainers globalSetup (`test/integration-global-setup.ts`) spins an ephemeral
 * `postgres:16-alpine` and sets THEOLENS_PG_URI when it is not already provided, so a bare
 * `pnpm test:integration` NEVER silently skips the query layer. An externally-set THEOLENS_PG_URI
 * (local docker-compose PG / CI) is honored as a fast path — no container is started.
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
    include: ["packages/**/src/**/*.integration.test.ts", "test/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    globalSetup: ["./test/integration-global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Container start can take longer than a query timeout on a cold image pull.
    teardownTimeout: 60_000,
    fileParallelism: false,
    globals: false,
  },
});
