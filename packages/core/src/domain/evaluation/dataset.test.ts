import { describe, it, expect } from "vitest";
import { normalizeDatasetName, DATASET_NAME_MAX } from "./dataset.js";

describe("normalizeDatasetName", () => {
  it("test_normalize_dataset_name_trims", () => {
    expect(normalizeDatasetName("  travel  ")).toBe("travel");
  });

  it("test_normalize_dataset_name_preserves_case", () => {
    // "Travel" ≠ "travel" — lowercasing would silently merge distinct datasets
    expect(normalizeDatasetName("Travel")).toBe("Travel");
  });

  it("test_normalize_dataset_name_rejects_blank", () => {
    expect(normalizeDatasetName("")).toBeNull();
    expect(normalizeDatasetName("   ")).toBeNull();
  });

  it("test_normalize_dataset_name_total_never_throws", () => {
    expect(normalizeDatasetName(null)).toBeNull();
    expect(normalizeDatasetName(undefined)).toBeNull();
    expect(normalizeDatasetName(42)).toBeNull();
    expect(normalizeDatasetName({})).toBeNull();
  });

  it("test_normalize_dataset_name_caps_length", () => {
    expect(normalizeDatasetName("x".repeat(DATASET_NAME_MAX + 50))).toHaveLength(
      DATASET_NAME_MAX,
    );
  });
});
