import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpanFilterBar } from "./SpanFilterBar.js";

describe("SpanFilterBar (M30)", () => {
  it("test_span_filter_bar_updates_query_debounced", async () => {
    const onChange = vi.fn();
    render(<SpanFilterBar onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("filter spans"), "kind:llm");
    // debounced — the final value is forwarded
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("kind:llm"));
  });

  it("test_span_filter_bar_clear_removes_spanquery", async () => {
    const onChange = vi.fn();
    render(<SpanFilterBar value="kind:tool" onChange={onChange} />);
    const input = screen.getByLabelText("filter spans");
    await userEvent.clear(input);
    // an empty bar is "no filter" → undefined, not ""
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(undefined));
  });

  it("test_span_filter_bar_renders_seeded_value", () => {
    render(<SpanFilterBar value="status:error" onChange={() => {}} />);
    expect(screen.getByLabelText("filter spans")).toHaveValue("status:error");
  });
});
