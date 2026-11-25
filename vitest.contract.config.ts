import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Contract (unit) test config — fast, in-memory, no I/O.
 * Excludes integration (*.integration suffix not used; integration tests live
 * under packages and are gated by env) and e2e. Aliases the core package to its
 * src so tests run against live source, not built dist.
 */
export default defineConfig({
  resolve: {
    alias: {
      // M122/M128: specific-before-base — subpath aliases MUST precede the bare
      // `@looptrace/core` alias so vite's prefix matcher routes /infra + /testing correctly.
      "@looptrace/core/infra": fileURLToPath(
        new URL("./packages/core/src/infrastructure/db/index.ts", import.meta.url),
      ),
      // M128 — the shared drift-guard fixture moved off the prod root barrel to the
      // `@looptrace/core/testing` subpath; the SDK mapper-drift test resolves it here.
      "@looptrace/core/testing": fileURLToPath(
        new URL("./packages/core/src/domain/theokit/theokit-vectors.ts", import.meta.url),
      ),
      // M129 — the three domain sub-barrels exposed as subpath exports (shrinking the root
      // god-barrel). Each MUST precede the bare `@looptrace/core` alias (specific-before-base).
      "@looptrace/core/observability": fileURLToPath(
        new URL("./packages/core/src/domain/observability/index.ts", import.meta.url),
      ),
      "@looptrace/core/evaluation": fileURLToPath(
        new URL("./packages/core/src/domain/evaluation/index.ts", import.meta.url),
      ),
      "@looptrace/core/provider": fileURLToPath(
        new URL("./packages/core/src/domain/provider/index.ts", import.meta.url),
      ),
      "@looptrace/core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url),
      ),
      "@looptrace/api": fileURLToPath(
        new URL("./packages/api/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/**/src/**/*.test.ts"],
    // packages/web runs under its own jsdom config (pnpm --filter @looptrace/web test);
    // exclude it here so UI tests don't run in the node-env contract suite.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.integration.test.ts",
      "packages/web/**",
    ],
    globals: false,
  },
});
