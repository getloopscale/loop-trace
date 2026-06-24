import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SavedViewSelector } from "./SavedViewSelector.js";
import type { ListTracesQuery } from "../api/types.js";

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe("SavedViewSelector (M29b)", () => {
  it("test_saved_view_save_then_apply", async () => {
    const onApply = vi.fn();
    const query: ListTracesQuery = { status: "error", model: "gpt-4o" };
    render(<SavedViewSelector query={query} onApply={onApply} />);

    await userEvent.type(screen.getByLabelText("view name"), "prod errors");
    await userEvent.click(screen.getByRole("button", { name: "Save view" }));
    // the saved view is now an option; selecting it applies its query
    await userEvent.selectOptions(
      screen.getByLabelText("saved views"),
      "prod errors",
    );
    expect(onApply).toHaveBeenCalledWith({ status: "error", model: "gpt-4o" });
  });

  it("test_saved_view_delete", async () => {
    render(<SavedViewSelector query={{ status: "ok" }} onApply={() => {}} />);
    await userEvent.type(screen.getByLabelText("view name"), "v1");
    await userEvent.click(screen.getByRole("button", { name: "Save view" }));
    await userEvent.selectOptions(screen.getByLabelText("saved views"), "v1");
    await userEvent.click(
      screen.getByRole("button", { name: "delete selected view" }),
    );
    // option gone
    expect(
      screen.queryByRole("option", { name: "v1" }),
    ).toBeNull();
  });

  it("test_save_button_disabled_when_name_blank", () => {
    render(<SavedViewSelector query={{}} onApply={() => {}} />);
    expect(screen.getByRole("button", { name: "Save view" })).toBeDisabled();
  });
});
