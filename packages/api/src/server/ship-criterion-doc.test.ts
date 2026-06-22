import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * DoD #2 (M8): the README must document the V1 ship criterion (the automated
 * ship-gate command) AND a reference environment for the <15-min budget
 * (risk #2), and MUST NOT make unevidenced "production-ready" claims
 * (rules/public-copy.md). Repo-root README, four levels up.
 */
const README = fileURLToPath(new URL("../../../../README.md", import.meta.url));
const BANNED = ["production-ready", "production-grade", "battle-tested", "enterprise-ready"];

describe("README V1 ship criterion + reference env (M8, T4.1)", () => {
  it("test_readme_documents_ship_criterion_and_reference_env", () => {
    const text = readFileSync(README, "utf8");
    expect(text).toContain("pnpm test:e2e");
    expect(text.toLowerCase()).toContain("ship criterion");
    expect(text.toLowerCase()).toContain("reference environment");
    for (const term of BANNED) {
      expect(text.toLowerCase()).not.toContain(term);
    }
  });
});
