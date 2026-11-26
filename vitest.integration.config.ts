import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Integration test config — runs *.integration.test.ts against a real Postgres.
 * M97 (B-M4): a Testcontainers globalSetup (`test/integration-global-setup.ts`) spins an ephemeral
 * `postgres:19-alpine` and sets LOOPTRACE_PG_URI when it is not already provided, so a bare
 * `pnpm test:integration` NEVER silently skips the query layer. An externally-set LOOPTRACE_PG_URI
 * (local docker-compose PG / CI) is honored as a fast path — no container is started.
 * Longer timeout for DB setup; fileParallelism off to avoid TRUNCATE races.
 *
 * M102 (M95 F3 / M97) — test-DB isolation decision: the suite shares ONE Testcontainers Postgres
 * across files, isolated by (a) `fileParallelism: false` (no two files run concurrently), (b) a
 * per-test `TRUNCATE` in each file's `beforeEach`, (c) the migrate-on-boot test's dynamic drop of every
 * `public` table (M95 fix — no stale-list corruption), and (d) the never-silently-skip meta-guard.
 * This runs the full suite green in one shot (33 files / 268 tests). Full per-file DB/schema isolation
 * (a container or schema per file) was considered and DECLINED: it multiplies container/DDL startup
 * across 33 files for no correctness gain over the guards above, which already prevent cross-file
 * bleed. Revisit only if `fileParallelism` is ever turned on.
 */
export default defineConfig({
  resolve: {
    alias: {
      // M122: specific-before-base — the subpath alias MUST precede the bare
      // `@looptrace/core` alias so vite's prefix matcher routes /infra correctly.
      "@looptrace/core/infra": fileURLToPath(
        new URL("./packages/core/src/infrastructure/db/index.ts", import.meta.url),
      ),
      "@looptrace/core/provider": fileURLToPath(
        new URL("./packages/core/src/domain/provider/index.ts", import.meta.url),
      ),
      "@looptrace/core/testing": fileURLToPath(
        new URL("./packages/core/src/domain/theokit/theokit-vectors.ts", import.meta.url),
      ),
      "@looptrace/core/observability": fileURLToPath(
        new URL("./packages/core/src/domain/observability/index.ts", import.meta.url),
      ),
      "@looptrace/core/evaluation": fileURLToPath(
        new URL("./packages/core/src/domain/evaluation/index.ts", import.meta.url),
      ),
      "@looptrace/core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url),
      ),
      // M105: the SDK ↔ engine contract test builds the real app via createApp (exported from the
      // api test barrel). Mirrors the contract config so `@looptrace/api` resolves to src.
      "@looptrace/api": fileURLToPath(
        new URL("./packages/api/src/index.ts", import.meta.url),
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
