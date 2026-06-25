import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddFilterBuilder } from "./AddFilterBuilder.js";

describe("AddFilterBuilder (M30b)", () => {
  it("test_add_filter_appends_kind_clause", async () => {
    const onChange = vi.fn();
    render(<AddFilterBuilder value="" onChange={onChange} />);
    // field defaults to kind → a kind value dropdown is shown
    await userEvent.selectOptions(screen.getByLabelText("filter value"), "llm");
    await userEvent.click(screen.getByRole("button", { name: "Add filter" }));
    expect(onChange).toHaveBeenCalledWith("kind:llm");
  });

  it("test_add_filter_appends_to_existing", async () => {
    const onChange = vi.fn();
    render(<AddFilterBuilder value="kind:llm" onChange={onChange} />);
    await userEvent.selectOptions(screen.getByLabelText("filter field"), "status");
    await userEvent.selectOptions(screen.getByLabelText("filter value"), "error");
    await userEvent.click(screen.getByRole("button", { name: "Add filter" }));
    expect(onChange).toHaveBeenCalledWith("kind:llm status:error");
  });

  it("test_add_filter_quotes_whitespace_value", async () => {
    const onChange = vi.fn();
    render(<AddFilterBuilder value="" onChange={onChange} />);
    // name is a free-text value
    await userEvent.selectOptions(screen.getByLabelText("filter field"), "name");
    await userEvent.type(screen.getByLabelText("filter value"), "Chat Open AI");
    await userEvent.click(screen.getByRole("button", { name: "Add filter" }));
    expect(onChange).toHaveBeenCalledWith('name:"Chat Open AI"');
  });

  it("test_add_filter_add_disabled_when_value_blank", async () => {
    render(<AddFilterBuilder value="" onChange={() => {}} />);
    await userEvent.selectOptions(screen.getByLabelText("filter field"), "model");
    // model is text, empty → Add disabled
    expect(screen.getByRole("button", { name: "Add filter" })).toBeDisabled();
  });

  it("test_add_filter_field_switch_resets_value", async () => {
    // Switching the field resets the value control to that field's default — an enum
    // field gets its first value; a text field clears (review F-test-1).
    render(<AddFilterBuilder value="" onChange={() => {}} />);
    // kind → status: the value dropdown defaults to the first status ("ok")
    await userEvent.selectOptions(screen.getByLabelText("filter field"), "status");
    expect(screen.getByLabelText("filter value")).toHaveValue("ok");
    // status → name: the value control becomes an empty text input (Add disabled)
    await userEvent.selectOptions(screen.getByLabelText("filter field"), "name");
    expect(screen.getByLabelText("filter value")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Add filter" })).toBeDisabled();
  });
});
