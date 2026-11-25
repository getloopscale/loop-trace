import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { LIST_TRACES_LIMIT_CAP } from "@looptrace/core";

// M56 — the read API the dashboard consumes MUST be documented so a customer can pull the same data
// with their looptrace_live_* key. This asserts the doc exists and covers the load-bearing contract
// (endpoint, auth, filters, the cap, response shape) — a doc has no runtime behavior to unit-test.
describe("read API doc (M56)", () => {
  const path = "docs/lens-read-api.md"; // relative to the repo root (vitest cwd)

  it("test_read_api_doc_present_and_covers_the_contract", () => {
    expect(existsSync(path)).toBe(true);
    const doc = readFileSync(path, "utf-8");
    // endpoint + per-tenant auth
    expect(doc).toContain("GET /v1/traces");
    expect(doc).toContain("looptrace_live_");
    expect(doc).toContain("observability:read");
    // the filter params it must document
    for (const p of ["status", "model", "from", "to", "min_cost_usd", "max_tokens", "session_id", "limit", "offset"]) {
      expect(doc, `doc should document the '${p}' filter param`).toContain(p);
    }
    // the documented cap MUST match the code (no drift)
    expect(doc).toContain(String(LIST_TRACES_LIMIT_CAP));
    // response shape
    expect(doc).toContain("traceId");
    expect(doc).toContain("costUsd");
  });
});
