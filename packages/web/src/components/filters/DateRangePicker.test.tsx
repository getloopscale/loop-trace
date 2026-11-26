import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateRangePicker } from "./DateRangePicker.js";
import { RangeProvider, useRange } from "../../hooks/useRange.js";

function ShowRange() {
  return <span data-testid="range">{useRange().range}</span>;
}

function renderPicker() {
  return render(
    <>
      <RangeProvider>
        <DateRangePicker />
        <ShowRange />
      </RangeProvider>
    </>,
  );
}

describe("DateRangePicker (M29b)", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it("test_date_range_picker_renders_presets", () => {
    renderPicker();
    const select = screen.getByLabelText("date range") as HTMLSelectElement;
    expect(select.value).toBe("7d"); // default
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels).toEqual([
      "Last 1 hour",
      "Last 24 hours",
      "Last 7 days",
      "Last 30 days",
    ]);
  });

  it("test_date_range_picker_changes_range", async () => {
    renderPicker();
    await userEvent.selectOptions(screen.getByLabelText("date range"), "30d");
    expect(screen.getByTestId("range").textContent).toBe("30d");
  });
});
