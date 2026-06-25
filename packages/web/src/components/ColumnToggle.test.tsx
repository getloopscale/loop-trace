import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ColumnToggle } from "./ColumnToggle.js";

const cols = [
  { key: "model", label: "Model" },
  { key: "cost", label: "Cost" },
];

describe("ColumnToggle (M29d)", () => {
  it("test_column_toggle_lists_a_checkbox_per_column", () => {
    render(<ColumnToggle columns={cols} hidden={new Set()} onToggle={() => {}} />);
    // a visible column is a checked checkbox
    expect(screen.getByRole("checkbox", { name: "Cost" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Model" })).toBeChecked();
  });

  it("test_column_toggle_reflects_hidden_state", () => {
    render(
      <ColumnToggle columns={cols} hidden={new Set(["cost"])} onToggle={() => {}} />,
    );
    // a hidden column is an unchecked checkbox
    expect(screen.getByRole("checkbox", { name: "Cost" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Model" })).toBeChecked();
  });

  it("test_column_toggle_calls_onToggle", async () => {
    const onToggle = vi.fn();
    render(<ColumnToggle columns={cols} hidden={new Set()} onToggle={onToggle} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Cost" }));
    expect(onToggle).toHaveBeenCalledWith("cost");
  });
});
