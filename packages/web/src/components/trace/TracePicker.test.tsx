import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TracePicker } from "./TracePicker.js";
import type { TraceListItem } from "../../api/types.js";

const traces: TraceListItem[] = [
  { traceId: "t-new", name: "checkout" },
  { traceId: "t-old", name: "search" },
];

describe("TracePicker (M21)", () => {
  it("trace_picker_defaults_to_most_recent_and_changes", async () => {
    const onChange = vi.fn();
    render(<TracePicker traces={traces} value="t-new" onChange={onChange} />);
    const select = screen.getByRole("combobox", { name: "select trace" });
    // the controlled value (most-recent = first) is selected
    expect(select).toHaveValue("t-new");
    expect(screen.getByText("checkout")).toBeInTheDocument();
    // selecting another fires onChange with its id
    await userEvent.selectOptions(select, "t-old");
    expect(onChange).toHaveBeenCalledWith("t-old");
  });

  it("trace_picker_falls_back_to_trace_id_without_name", () => {
    render(
      <TracePicker
        traces={[{ traceId: "abc123" }]}
        value="abc123"
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole("option", { name: "abc123" })).toBeInTheDocument();
  });
});
