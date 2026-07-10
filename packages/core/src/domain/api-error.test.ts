import { describe, expect, it } from "vitest";
import { z } from "zod";

import { apiError, zodFieldErrors } from "./api-error.js";

describe("apiError", () => {
  it("builds the {code,message} envelope without details when none given", () => {
    expect(apiError("NOT_FOUND", "not found")).toEqual({ code: "NOT_FOUND", message: "not found" });
  });

  it("includes details when non-empty", () => {
    expect(apiError("INVALID_QUERY", "invalid", [{ field: "range", issue: "bad" }])).toEqual({
      code: "INVALID_QUERY",
      message: "invalid",
      details: [{ field: "range", issue: "bad" }],
    });
  });

  it("omits details entirely when the array is empty (never details: [])", () => {
    const body = apiError("X", "m", []);
    expect(body).toEqual({ code: "X", message: "m" });
    expect("details" in body).toBe(false);
  });
});

describe("zodFieldErrors", () => {
  it("names the offending field and its issue", () => {
    const r = z.object({ a: z.string() }).safeParse({ a: 1 });
    expect(r.success).toBe(false);
    if (r.success) return;
    const fields = zodFieldErrors(r.error);
    expect(fields).toHaveLength(1);
    expect(fields[0]?.field).toBe("a");
    expect(fields[0]?.issue).toMatch(/string/i);
  });

  it("dot-joins nested paths and uses <root> for a top-level error", () => {
    const nested = z.object({ a: z.object({ b: z.string() }) }).safeParse({ a: { b: 1 } });
    if (nested.success) throw new Error("expected failure");
    expect(zodFieldErrors(nested.error)[0]?.field).toBe("a.b");

    const root = z.string().safeParse(123);
    if (root.success) throw new Error("expected failure");
    expect(zodFieldErrors(root.error)[0]?.field).toBe("<root>");
  });

  it("M102 — never reflects raw user input (a hostile enum value is not echoed)", () => {
    const r = z.object({ tier: z.enum(["gold", "silver"]) }).safeParse({ tier: "<script>alert(1)</script>" });
    if (r.success) throw new Error("expected failure");
    const fields = zodFieldErrors(r.error);
    expect(fields[0]?.field).toBe("tier");
    // the issue names the allowed SCHEMA options, NOT the received hostile value
    expect(fields[0]?.issue).toBe("expected one of: gold, silver");
    expect(fields[0]?.issue).not.toContain("<script>");
  });
});
