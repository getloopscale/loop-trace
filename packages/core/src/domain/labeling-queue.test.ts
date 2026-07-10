import { describe, it, expect } from "vitest";

import {
  normalizeLabelResolution,
  RESOLUTION_SCHEMA_VERSION,
  type NormalizedResolution,
} from "./labeling-queue.js";

describe("M63 normalizeLabelResolution (pure + total)", () => {
  it("test_normalize_trims_label_and_caps_note_and_defaults", () => {
    const r = normalizeLabelResolution({ label: "  good  ", note: "  a note  " });
    expect(r).not.toBeNull();
    const nn = r as NormalizedResolution;
    expect(nn.label).toBe("good");
    expect(nn.note).toBe("a note");
    expect(nn.schemaVersion).toBe(RESOLUTION_SCHEMA_VERSION);
  });

  it("test_normalize_rejects_blank_label (empty resolution is not a review)", () => {
    // a resolution MUST carry a label — a blank/absent one is rejected (the route turns null into 400).
    expect(normalizeLabelResolution({ note: "only a note" })).toBeNull();
    expect(normalizeLabelResolution({ label: "   " })).toBeNull();
    expect(normalizeLabelResolution({})).toBeNull();
  });

  it("test_normalize_clamps_score_to_unit_interval_or_undefined", () => {
    expect(normalizeLabelResolution({ label: "x", score: 1.5 })?.score).toBe(1); // clamp high
    expect(normalizeLabelResolution({ label: "x", score: -0.5 })?.score).toBe(0); // clamp low
    expect(normalizeLabelResolution({ label: "x", score: 0 })?.score).toBe(0); // boundary 0 (edge)
    expect(normalizeLabelResolution({ label: "x", score: 1 })?.score).toBe(1); // boundary 1 (edge)
    expect(normalizeLabelResolution({ label: "x", score: 0.42 })?.score).toBe(0.42); // pass-through
    expect(normalizeLabelResolution({ label: "x", score: "abc" })?.score).toBeUndefined(); // non-number
    expect(normalizeLabelResolution({ label: "x", score: Number.NaN })?.score).toBeUndefined(); // NaN → undefined
    expect(normalizeLabelResolution({ label: "x", score: Number.POSITIVE_INFINITY })?.score).toBeUndefined(); // Inf → undefined
    expect(normalizeLabelResolution({ label: "x" })?.score).toBeUndefined(); // absent
  });

  it("test_normalize_caps_note_and_label_length", () => {
    const longNote = "n".repeat(5000);
    expect(normalizeLabelResolution({ label: "x", note: longNote })?.note).toHaveLength(2000); // NOTE_MAX
    const longLabel = "l".repeat(200);
    expect(normalizeLabelResolution({ label: longLabel })?.label).toHaveLength(64); // LABEL_MAX
  });

  it("test_normalize_is_total_never_throws (adversarial input)", () => {
    for (const bad of [null, undefined, 42, "str", [], { label: 5 }, { label: {} }]) {
      expect(() => normalizeLabelResolution(bad)).not.toThrow();
    }
    // a numeric/object label is not a string → treated as blank → null
    expect(normalizeLabelResolution({ label: 5 })).toBeNull();
  });

  it("test_normalize_warn_migrates_legacy_shape (never throws on an unknown payload)", () => {
    // a legacy payload with extra/renamed fields still yields a valid resolution stamped with the
    // current version (warn-and-migrate — D3), never a throw.
    const r = normalizeLabelResolution({ label: "ok", rating: 3, comment: "legacy" });
    expect(r?.schemaVersion).toBe(RESOLUTION_SCHEMA_VERSION);
    expect(r?.label).toBe("ok");
  });
});
