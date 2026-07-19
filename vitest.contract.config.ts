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
      // M122: specific-before-base — the subpath alias MUST precede the bare
      // `@usetheo/lens-core` alias so vite's prefix matcher routes /infra correctly.
      "@usetheo/lens-core/infra": fileURLToPath(
        new URL("./packages/core/src/infrastructure/db/index.ts", import.meta.url),
      ),
      "@usetheo/lens-core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url),
      ),
      "@usetheo/lens-api": fileURLToPath(
        new URL("./packages/api/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/**/src/**/*.test.ts"],
    // packages/web runs under its own jsdom config (pnpm --filter @usetheo/lens-web test);
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
