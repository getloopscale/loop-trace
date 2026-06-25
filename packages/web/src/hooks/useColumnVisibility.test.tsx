import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  readHiddenColumns,
  useColumnVisibility,
} from "./useColumnVisibility.js";

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

function Probe() {
  const { hidden, toggle } = useColumnVisibility();
  return (
    <div>
      <span data-testid="hidden">{[...hidden].sort().join(",")}</span>
      <button onClick={() => toggle("cost")}>toggle-cost</button>
    </div>
  );
}

describe("useColumnVisibility (M29d)", () => {
  it("test_column_visibility_defaults_all_visible", () => {
    render(<Probe />);
    expect(screen.getByTestId("hidden").textContent).toBe("");
    expect(readHiddenColumns()).toEqual([]);
  });

  it("test_column_visibility_round_trip", async () => {
    const { unmount } = render(<Probe />);
    await userEvent.click(screen.getByText("toggle-cost"));
    expect(screen.getByTestId("hidden").textContent).toBe("cost");
    expect(readHiddenColumns()).toEqual(["cost"]);
    unmount();
    // a fresh hook instance restores the persisted hidden set
    render(<Probe />);
    expect(screen.getByTestId("hidden").textContent).toBe("cost");
  });

  it("test_column_visibility_toggle_off_then_on", async () => {
    render(<Probe />);
    await userEvent.click(screen.getByText("toggle-cost")); // hide
    await userEvent.click(screen.getByText("toggle-cost")); // show again
    expect(screen.getByTestId("hidden").textContent).toBe("");
    expect(readHiddenColumns()).toEqual([]);
  });

  it("test_column_visibility_corrupt_storage_falls_back", () => {
    localStorage.setItem("theolens.columnVisibility", "{not json");
    expect(readHiddenColumns()).toEqual([]);
    localStorage.setItem("theolens.columnVisibility", '"a string not an array"');
    expect(readHiddenColumns()).toEqual([]);
  });

  it("test_column_visibility_filters_non_string_elements", () => {
    // a valid array with junk elements keeps only the strings (element-level guard)
    localStorage.setItem("theolens.columnVisibility", '["cost", 5, null, "model"]');
    expect(readHiddenColumns()).toEqual(["cost", "model"]);
  });

  it("test_column_visibility_disabled_storage_falls_back", () => {
    // Negative case (testing.md §4.1): disabled storage makes getItem THROW →
    // default (all visible / [] hidden), never crash.
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("disabled", "SecurityError");
      });
    try {
      expect(readHiddenColumns()).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
