import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * DoD #2 (M7): the SDK must be packable into a clean, installable tarball — the
 * unit a third party would `npm install`. Asserts the produced `.tgz` ships the
 * compiled `dist` + types + manifest and EXCLUDES `src` (so consumers get the
 * built artifact, not source). Parses the real tarball listing via `tar -tzf`
 * (npm-vs-pnpm JSON shapes differ — EC-3).
 */
const SDK_DIR = fileURLToPath(new URL("..", import.meta.url));

describe("SDK packaging (M7, T2.2)", () => {
  it("test_sdk_tarball_includes_dist_and_excludes_src", () => {
    const dest = mkdtempSync(join(tmpdir(), "lens-sdk-pack-"));
    execFileSync("pnpm", ["pack", "--pack-destination", dest], {
      cwd: SDK_DIR,
      encoding: "utf8",
      stdio: "pipe",
    });
    const tgz = readdirSync(dest).find((f) => f.endsWith(".tgz"));
    expect(tgz, "a .tgz should be produced").toBeTruthy();

    const listing = execFileSync("tar", ["-tzf", join(dest, tgz as string)], {
      encoding: "utf8",
    });
    const entries = listing.split("\n");
    expect(entries).toContain("package/dist/index.js");
    expect(entries).toContain("package/dist/index.d.ts");
    expect(entries).toContain("package/package.json");
    // No source ships in the published artifact.
    expect(entries.some((e) => e.startsWith("package/src/"))).toBe(false);
  });
});
