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
      "@usetheo/lens-core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/**/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
    globals: false,
  },
});
