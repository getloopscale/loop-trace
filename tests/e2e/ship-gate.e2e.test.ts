import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// The pure replay computation the UI uses — imported to prove step 4 on REAL
// ingested data without a browser (deterministic — D1, risk #1).
import { buildReplaySteps } from "../../packages/web/src/lib/replay.js";
import type { TraceTreeNode } from "../../packages/web/src/api/types.js";

const BASE = process.env["THEOLENS_E2E_BASE"] ?? "http://localhost:44318";
const EXAMPLE = fileURLToPath(
  new URL("../../examples/agent/index.ts", import.meta.url),
);

/**
 * M8 ship gate — the binary V1 criterion. Walks the 6 PRD Success-Criteria steps
 * as ONE journey from a clean composed stack, keying every assertion off the
 * example agent's OWN returned trace id (the e2e DB is shared/accumulating across
 * test files — EC-1), and asserting membership ("contains") never position. The
 * UI steps are proven via the same HTTP contracts the UI consumes + the pure
 * replay function — no browser, no sleeps (deterministic).
 */
describe("V1 ship gate — 6-step Success Criteria from a clean stack (e2e)", () => {
  it("test_v1_ship_criterion_six_step_journey_from_clean_stack", async () => {
    const startedAt = Date.now();

    // Step 1 — the stack is up and the UI is served same-origin.
    const ui = await fetch(`${BASE}/`);
    expect(ui.status, "step 1: UI served").toBe(200);
    expect(ui.headers.get("content-type")).toContain("text/html");
    expect(await ui.text()).toContain('id="root"');

    // Step 2 — instrument + run the ≤10-line example agent against the stack.
    const out = execFileSync("pnpm", ["tsx", EXAMPLE], {
      encoding: "utf8",
      env: { ...process.env, THEOLENS_ENDPOINT: BASE },
    });
    const traceId = /THEOLENS_TRACE_ID=([0-9a-f]+)/.exec(out)?.[1];
    expect(traceId, `step 2: example emitted a trace id (stdout: ${out})`).toBeTruthy();

    // Step 3 — spans arrived via OTLP; the execution tree appears in the Explorer.
    const list = (await (await fetch(`${BASE}/v1/traces`)).json()) as {
      traces: { traceId: string }[];
    };
    expect(
      list.traces.some((t) => t.traceId === traceId),
      "step 3: the execution appears in the trace list",
    ).toBe(true);

    const tree = (await (
      await fetch(`${BASE}/v1/traces/${traceId}`)
    ).json()) as TraceTreeNode;
    expect(tree.name, "step 3: root span is the agent run").toBe("checkout");
    expect(
      tree.children.map((c) => c.name),
      "step 3: the tool call is a child span",
    ).toContain("search-products");

    // Step 4 — open the Replay and walk the steps (the UI's pure replay function
    // on the real ingested tree: deterministic preorder, parent before tool).
    const steps = buildReplaySteps(tree);
    expect(steps.length, "step 4: replay has at least the root + tool steps").toBeGreaterThanOrEqual(2);
    expect(steps[0]?.name, "step 4: replay starts at the agent run").toBe("checkout");
    expect(
      steps.map((s) => s.name),
      "step 4: the tool step is in the replay sequence",
    ).toContain("search-products");

    // Step 5 — see cost + tokens of the execution.
    const cost = (await (
      await fetch(`${BASE}/v1/traces/${traceId}/cost`)
    ).json()) as { costUsd: number; totalTokens: number };
    expect(cost.costUsd, "step 5: a positive USD cost").toBeGreaterThan(0);
    expect(cost.totalTokens, "step 5: token total").toBeGreaterThan(0);

    // Step 6 — see tool analytics (the example's tool is ranked).
    const tools = (await (
      await fetch(`${BASE}/v1/analytics/tools`)
    ).json()) as { tools: { toolName: string }[] };
    expect(
      tools.tools.map((t) => t.toolName),
      "step 6: the tool appears in tool analytics",
    ).toContain("search-products");

    // The V1 product criterion is < 15 min; the gate runs in seconds. Assert with
    // a wide margin (risk #2 — the budget is documented against a reference env).
    const elapsedMs = Date.now() - startedAt;
    console.error(
      JSON.stringify({ level: "info", msg: "ship_gate_elapsed_ms", elapsedMs }),
    );
    expect(elapsedMs, "the 6-step journey is well within the <15-min budget").toBeLessThan(
      10 * 60 * 1000,
    );
  });
});
