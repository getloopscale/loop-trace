import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * DoD #3 (M7): the repo README must document the zero-to-first-trace quickstart
 * so a newcomer can go from clone to a visible trace. This pins the load-bearing
 * steps (commands matching real scripts) so the doc cannot silently drift from
 * the one-command stack it describes. (Repo-root README, four levels up.)
 */
const README = fileURLToPath(new URL("../../../../README.md", import.meta.url));

describe("README quickstart (M7, T2.3)", () => {
  it("test_readme_quickstart_has_compose_up_and_ui_url", () => {
    const text = readFileSync(README, "utf8");
    expect(text).toContain("docker compose up");
    expect(text).toContain("http://localhost:4318");
    // The onboarding shows the instrumentation itself. It used to point at
    // `examples/agent`, retired in 675e6cb — the runnable agent now lives in the
    // e2e harness (tests/e2e/fixtures/), so the README teaches the SDK calls
    // inline instead of linking a published example.
    expect(text).toContain("initLoopTrace");
    expect(text).toContain("@looptrace/sdk");
  });
});
