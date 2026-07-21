import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * M135 — the breach predicate must stay identical across the two queries that use it.
 *
 * `listBreachingTraces` answers "WHICH traces breached" (the drill-down) and `monitorBreachWindow`
 * answers "HOW MANY breached in this window" (what the scheduled evaluator thresholds). They carry
 * the same `CASE g.operator` ladder, and a comment asks the next author to keep them in lock-step.
 *
 * A comment is not enforcement. If the two drift, the count that fires an alert and the list the
 * customer opens to investigate it disagree — and nothing fails, because each query is internally
 * consistent. The customer is told N traces breached and shown M. This test makes that drift
 * mechanical instead of dependent on someone reading a comment.
 */
const SRC = fileURLToPath(new URL("./drizzle-evaluator-repository.ts", import.meta.url));

function breachArms(source: string, methodName: string): string[] {
  const start = source.indexOf(`async ${methodName}(`);
  expect(start, `${methodName} not found — did it get renamed?`).toBeGreaterThan(-1);
  const body = source.slice(start, start + 3000);
  return body
    .split("\n")
    .filter((line) => line.includes("WHEN '"))
    .map((line) => line.trim());
}

describe("M135 breach-predicate lock-step", () => {
  it("test_window_count_and_drilldown_list_share_one_breach_predicate", () => {
    const src = readFileSync(SRC, "utf8");
    const windowed = breachArms(src, "monitorBreachWindow");
    const list = breachArms(src, "listBreachingTraces");

    // Non-empty guards against the check silently passing on two empty arrays if either query is
    // rewritten into a form this parser no longer sees.
    expect(windowed.length).toBeGreaterThan(0);
    expect(windowed).toEqual(list);
  });
});
