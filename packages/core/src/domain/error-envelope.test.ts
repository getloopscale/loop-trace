import { describe, it, expect } from "vitest";

import { apiError } from "./api-error.js";
import { errorBody, ERROR_CODES, isErrorCode } from "./error-envelope.js";

/**
 * M118 (T5.1 / D3) — one typed error envelope. `errorBody(code, message)` produces the SAME shape as
 * `apiError` (same keys/order) but with a `code` constrained to the `ERROR_CODES` union — so a typo'd
 * code is a compile error, and every error body is greppable/auditable. R5: the exact code strings are
 * preserved by the migration.
 */
describe("M118 error envelope", () => {
  it("test_error_envelope_shape_matches_apiError", () => {
    // errorBody is structurally identical to apiError for the same inputs.
    expect(errorBody("RATE_LIMITED", "too many")).toEqual(apiError("RATE_LIMITED", "too many"));
    expect(errorBody("NOT_FOUND", "nope")).toEqual({ code: "NOT_FOUND", message: "nope" });
    // details are carried through (same as apiError).
    expect(errorBody("INVALID_QUERY", "bad", [{ field: "q", issue: "x" }])).toEqual(
      apiError("INVALID_QUERY", "bad", [{ field: "q", issue: "x" }]),
    );
  });

  it("test_every_envelope_code_is_a_member_of_ERROR_CODES", () => {
    // A representative sample of the codes the surface returns must be in the union.
    for (const code of ["RATE_LIMITED", "PAYLOAD_TOO_LARGE", "TRACE_NOT_FOUND", "REPLAY_UNAVAILABLE", "COPILOT_UNAVAILABLE", "INVALID_BODY"] as const) {
      expect(ERROR_CODES.includes(code)).toBe(true);
      expect(isErrorCode(code)).toBe(true);
    }
    expect(isErrorCode("NOT_A_REAL_CODE")).toBe(false);
  });

  it("test_migration_preserves_exact_code_string", () => {
    // The representative formerly-inline codes keep their exact string (R5 — a client contract).
    expect(errorBody("RATE_LIMITED", "x").code).toBe("RATE_LIMITED");
    expect(errorBody("REPLAY_DISABLED", "x").code).toBe("REPLAY_DISABLED");
    expect(errorBody("COPILOT_UNAVAILABLE", "x").code).toBe("COPILOT_UNAVAILABLE");
  });
});
