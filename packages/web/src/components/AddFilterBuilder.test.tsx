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
});
