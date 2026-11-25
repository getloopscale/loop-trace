import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const BASE = process.env["LOOPTRACE_E2E_BASE"] ?? "http://localhost:44318";
const EXAMPLE = fileURLToPath(
  new URL("./fixtures/instrumented-agent.ts", import.meta.url),
);

describe("Example agent ingestion (e2e)", () => {
  it("example_agent_spans_ingested_from_clean_stack", async () => {
    // Run the ≤10-line example against the live stack; it prints its trace id.
    const out = execFileSync("pnpm", ["tsx", EXAMPLE], {
      encoding: "utf8",
      env: { ...process.env, LOOPTRACE_ENDPOINT: BASE },
    });
    const traceId = /LOOPTRACE_TRACE_ID=([0-9a-f]+)/.exec(out)?.[1];
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
    // The M2 onboarding promise measures ONLY the user-written instrumentation,
    // delimited in the example by `// looptrace:instrument:start/end` markers — so the
    // e2e-only harness (env default, trace-id print) is genuinely excluded, not
    // just claimed to be (review F-test-7).
    const src = readFileSync(EXAMPLE, "utf8");
    const all = src.split("\n");
    const start = all.findIndex((l) => l.includes("looptrace:instrument:start"));
    const end = all.findIndex((l) => l.includes("looptrace:instrument:end"));
    expect(start, "instrumentation start marker missing").toBeGreaterThanOrEqual(0);
    expect(end, "instrumentation end marker missing").toBeGreaterThan(start);
    const body = all
      .slice(start + 1, end)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//"));
    expect(body.length).toBeLessThanOrEqual(10);
  });
});
