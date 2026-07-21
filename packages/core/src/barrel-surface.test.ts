import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import * as rootBarrel from "./index.js";
import * as infra from "@usetheo/lens-core/infra";

/**
 * M122 boundary guard: the root barrel (`@usetheo/lens-core`) is the DOMAIN public
 * API. The 13 infrastructure concretes (7 Drizzle repo symbols + 6 raw table
 * schemas) live ONLY behind the `@usetheo/lens-core/infra` subpath. These tests are
 * the permanent re-leak guard — re-exporting any infra symbol from the root fails here.
 */
const INFRA_SYMBOLS = [
  "DrizzleSpanRepository",
  "createPool",
  "createSpanRepository",
  "migrateLatest",
  "DrizzleEvaluatorRepository",
  "createEvaluatorRepository",
  "evaluatorRepoFromPool",
  "spans",
  "traces",
  "sessions",
  "replaySessions",
  "evaluators",
  "monitors",
] as const;

describe("M122 core public boundary", () => {
  it("test_root_barrel_exports_no_infra_symbol", () => {
    const rootKeys = new Set(Object.keys(rootBarrel));
    const leaked = INFRA_SYMBOLS.filter((name) => rootKeys.has(name));
    expect(leaked).toEqual([]);
  });

  it("test_infra_subpath_exports_all_concretes", () => {
    const infraKeys = new Set(Object.keys(infra));
    const missing = INFRA_SYMBOLS.filter((name) => !infraKeys.has(name));
    expect(missing).toEqual([]);
    // Repo factories/classes are runtime values; the 6 tables are Drizzle table objects.
    expect(typeof infra.createSpanRepository).toBe("function");
    expect(typeof infra.migrateLatest).toBe("function");
    expect(typeof infra.createPool).toBe("function");
    expect(typeof infra.evaluatorRepoFromPool).toBe("function");
    expect(infra.spans).toBeDefined();
    expect(infra.evaluators).toBeDefined();
  });

  it("test_package_exports_declares_infra_subpath", () => {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      exports: Record<string, { types?: string; default?: string }>;
    };
    expect(pkg.exports["./infra"]?.default).toBe("./dist/infrastructure/db/index.js");
    expect(pkg.exports["./infra"]?.types).toBe("./dist/infrastructure/db/index.d.ts");
    // The domain root condition stays intact.
    expect(pkg.exports["."]?.default).toBe("./dist/index.js");
  });
});
