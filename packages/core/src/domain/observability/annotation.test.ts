import { describe, it, expect } from "vitest";
import { normalizeAnnotation, ANNOTATION_NOTE_MAX } from "./annotation.js";

describe("normalizeAnnotation", () => {
  it("test_normalize_thumbs_up_only", () => {
    // a 👍 with no note is valid (label alone counts)
    const a = normalizeAnnotation({ label: "thumbs_up" });
    expect(a).toEqual({
      spanId: undefined,
      name: "feedback",
      label: "thumbs_up",
      note: undefined,
      annotatorKind: "HUMAN",
    });
  });

  it("test_normalize_note_only", () => {
    // a free-text note with no label is valid (note alone counts)
    const a = normalizeAnnotation({ note: "looks wrong" });
    expect(a?.note).toBe("looks wrong");
    expect(a?.label).toBeUndefined();
  });

  it("test_normalize_span_level_and_channel", () => {
    const a = normalizeAnnotation({
      spanId: "s1",
      name: "tone",
      label: "thumbs_down",
      annotatorKind: "HUMAN",
    });
    expect(a).toEqual({
      spanId: "s1",
      name: "tone",
      label: "thumbs_down",
      note: undefined,
      annotatorKind: "HUMAN",
    });
  });

  it("test_normalize_rejects_empty", () => {
    // no label AND no note → not feedback → null (route → 400)
    expect(normalizeAnnotation({})).toBeNull();
    expect(normalizeAnnotation({ label: "   ", note: "  " })).toBeNull();
    expect(normalizeAnnotation({ spanId: "s1" })).toBeNull();
  });

  it("test_normalize_total_never_throws", () => {
    // PURE + TOTAL: non-object / null / odd inputs return null, never throw
    expect(normalizeAnnotation(null)).toBeNull();
    expect(normalizeAnnotation(undefined)).toBeNull();
    expect(normalizeAnnotation("nope")).toBeNull();
    expect(normalizeAnnotation(42)).toBeNull();
    expect(normalizeAnnotation({ label: 7, note: {} })).toBeNull(); // non-strings ignored → empty → null
  });

  it("test_normalize_trims_and_caps_note", () => {
    expect(normalizeAnnotation({ note: "  spaced  " })?.note).toBe("spaced");
    const long = "x".repeat(ANNOTATION_NOTE_MAX + 50);
    expect(normalizeAnnotation({ note: long })?.note).toHaveLength(ANNOTATION_NOTE_MAX);
  });

  it("test_normalize_blank_spanId_is_trace_level", () => {
    // a blank spanId normalizes to undefined (trace-level), not "" noise
    expect(normalizeAnnotation({ spanId: "   ", label: "thumbs_up" })?.spanId).toBeUndefined();
  });
});
