import { describe, it, expect } from "vitest";
import { normalizeTag, TAG_MAX_LENGTH } from "./tags.js";
import { listTracesOptionsSchema } from "./trace-list.js";

describe("normalizeTag (M14 D4)", () => {
  it("test_normalize_tag_trims_and_preserves_case", () => {
    expect(normalizeTag("  Bug ")).toBe("Bug"); // trimmed, case preserved
    expect(normalizeTag("area/auth")).toBe("area/auth"); // slashes allowed (free-form)
  });

  it("test_normalize_tag_rejects_empty", () => {
    expect(normalizeTag("   ")).toBeNull();
    expect(normalizeTag("")).toBeNull();
    expect(normalizeTag(42)).toBeNull(); // non-string
  });

  it("test_normalize_tag_boundary_64_ok_65_reject", () => {
    expect(normalizeTag("a".repeat(TAG_MAX_LENGTH))).toBe("a".repeat(64));
    expect(normalizeTag("a".repeat(TAG_MAX_LENGTH + 1))).toBeNull();
  });
});

describe("listTracesOptionsSchema tag filter (M14 D3)", () => {
  it("test_list_options_accepts_tag", () => {
    expect(listTracesOptionsSchema.parse({ tag: "x" }).tag).toBe("x");
    expect(listTracesOptionsSchema.safeParse({ tag: "" }).success).toBe(false);
  });
});
