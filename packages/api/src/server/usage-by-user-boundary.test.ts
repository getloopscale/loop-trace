/**
 * M140 T4.4 (DoD-5) — the product boundary, enforced by a test rather than by good intentions.
 *
 * theo-lens REPORTS consumption it observed; theo-cloud is what BILLS (invariant 2 of the platform
 * contract). The two are one field name apart: the moment `usage-by-user` grows an `invoice`,
 * `account` or `charge`, this endpoint stops being observability and starts being a billing surface
 * — with none of the guarantees a billing surface needs, and derived from a price table we already
 * know can be incomplete.
 *
 * Documentation does not fail a pull request. This does.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Billing vocabulary. `cost`/`usd`/`price` are deliberately ABSENT: they are the legitimate language
// of observed consumption, and banning them would make the rule unusable rather than strict.
const BILLING_TERMS = /\b(invoice|billing|billed|chargeback|charge[sd]?|subscription|payment|payable)\b/i;

const FILES = [
  "../../../core/src/domain/observability/usage-by-user.ts",
  "../../../core/src/infrastructure/db/observability/usage-by-user-repository.ts",
  "./routes/analytics-routes.ts",
];

/**
 * Strip comments before matching. The prose that EXPLAINS the boundary necessarily names the thing
 * on the other side of it ("theo-cloud is what charges") — measured: the first run of this test
 * failed on its own explanatory comment. What must stay clean is the code: field names, types,
 * routes. A guard that forbids describing the rule cannot be lived with, and a rule nobody can live
 * with gets deleted.
 */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

describe("M140 — usage-by-user stays on the observability side of the boundary", () => {
  it("carries no billing vocabulary in any file the milestone added", () => {
    for (const rel of FILES) {
      const src = stripComments(readFileSync(new URL(rel, import.meta.url), "utf8"));
      const hit = BILLING_TERMS.exec(src);
      expect(
        hit,
        `${rel} uses billing vocabulary ("${hit?.[0]}"). theo-lens reports consumption; ` +
          `theo-cloud bills. If this endpoint genuinely needs to charge, that is a different ` +
          `milestone in a different repository — not a field added here.`,
      ).toBeNull();
    }
  });

  it("guards itself: the pattern really does fire on billing vocabulary", () => {
    // Without this, a typo in the regex would leave the boundary unguarded while the suite stays
    // green — the same class of defect this milestone spent its discovery phase measuring.
    expect(BILLING_TERMS.test("const invoice = { total: 1 };")).toBe(true);
    expect(BILLING_TERMS.test("if (billing) return;")).toBe(true);
    expect(BILLING_TERMS.test("costUsd, priceTable, usage")).toBe(false);
    // And the comment-stripper must not become an escape hatch: code still matches.
    expect(stripComments("// theo-cloud charges\nconst invoice = 1;")).toContain("invoice");
    expect(stripComments("// theo-cloud charges\nconst x = 1;")).not.toContain("charges");
  });
});
