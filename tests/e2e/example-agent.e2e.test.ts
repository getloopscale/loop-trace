import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const BASE = process.env["THEOLENS_E2E_BASE"] ?? "http://localhost:44318";
const EXAMPLE = fileURLToPath(
  new URL("../../examples/agent/index.ts", import.meta.url),
);

describe("Example agent ingestion (e2e)", () => {
  it("example_agent_spans_ingested_from_clean_stack", async () => {
    // Run the ≤10-line example against the live stack; it prints its trace id.
    const out = execFileSync("pnpm", ["tsx", EXAMPLE], {
      encoding: "utf8",
      env: { ...process.env, THEOLENS_ENDPOINT: BASE },
    });
    const traceId = /THEOLENS_TRACE_ID=([0-9a-f]+)/.exec(out)?.[1];
    expect(traceId, `example stdout: ${out}`).toBeTruthy();

    const res = await fetch(`${BASE}/v1/traces/${traceId}`);
    expect(res.status).toBe(200);
    const tree = (await res.json()) as {
      name: string;
      model?: string;
      children: { name: string }[];
    };
    expect(tree.name).toBe("checkout");
    expect(tree.model).toBe("gpt-4o");
    expect(tree.children.map((c) => c.name)).toContain("search-products");
  });

  it("example_instrumentation_is_at_most_10_lines", () => {
    // The instrumented body (excluding the import + the e2e-only trace-id glue
    // and console.log) must be ≤ 10 lines — the M2 onboarding promise.
    const src = readFileSync(EXAMPLE, "utf8");
    const lines = src
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("import "));
    expect(lines.length).toBeLessThanOrEqual(10);
  });
});
