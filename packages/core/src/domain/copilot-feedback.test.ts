import { describe, expect, it } from "vitest";
import { normalizeAskFeedback, InvalidFeedbackError } from "./copilot-feedback.js";

describe("normalizeAskFeedback (M83)", () => {
  it("accepts a minimal up/down body", () => {
    expect(normalizeAskFeedback({ turnId: "t-1", label: "up" })).toEqual({ turnId: "t-1", label: "up" });
    expect(normalizeAskFeedback({ turnId: "t-2", label: "down" })).toEqual({ turnId: "t-2", label: "down" });
  });

  it("carries optional spanId + question, trims + drops blanks", () => {
    expect(normalizeAskFeedback({ turnId: " t-3 ", label: "up", spanId: " s1 ", question: "why?" })).toEqual({
      turnId: "t-3",
      label: "up",
      spanId: "s1",
      question: "why?",
    });
    // blank optional fields are dropped, not stored as ""
    expect(normalizeAskFeedback({ turnId: "t-4", label: "down", spanId: "  ", question: "" })).toEqual({
      turnId: "t-4",
      label: "down",
    });
  });

  it("rejects a missing/blank turnId (negative case → typed error)", () => {
    expect(() => normalizeAskFeedback({ label: "up" })).toThrow(InvalidFeedbackError);
    expect(() => normalizeAskFeedback({ turnId: "   ", label: "up" })).toThrow(/turnId is required/);
    expect(() => normalizeAskFeedback({ turnId: "x".repeat(129), label: "up" })).toThrow(/turnId is required/);
  });

  it("rejects a label outside {up,down} (no silent coercion)", () => {
    expect(() => normalizeAskFeedback({ turnId: "t", label: "meh" })).toThrow(/label must be 'up' or 'down'/);
    expect(() => normalizeAskFeedback({ turnId: "t", label: true })).toThrow(InvalidFeedbackError);
    expect(() => normalizeAskFeedback({ turnId: "t" })).toThrow(/label must be/);
  });

  it("rejects a non-object body", () => {
    expect(() => normalizeAskFeedback(null)).toThrow(InvalidFeedbackError);
    expect(() => normalizeAskFeedback("nope")).toThrow(/must be an object/);
  });
});
