import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SpanIOPanel } from "./SpanIOPanel.js";
import type { SpanNodeData } from "../../api/types.js";

const base: SpanNodeData = {
  spanId: "s1",
  traceId: "t1",
  name: "op",
  startTimeUnixNano: "1700000000000000000",
  endTimeUnixNano: "1700000000500000000",
};

describe("SpanIOPanel", () => {
  it("span_io_panel_renders_input_output_markdown", () => {
    render(
      <SpanIOPanel
        span={{
          ...base,
          inputValue: "# Prompt\n**bold** ask",
          outputValue: "the answer",
        }}
      />,
    );
    // markdown is parsed (bold emphasis), not shown raw; the `# Prompt` heading is
    // demoted to a styled paragraph (FE-01 a11y) — present as text, NOT a page heading
    expect(screen.getByText("Prompt")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Prompt" })).toBeNull();
    expect(screen.getByText("bold")).toBeInTheDocument();
    expect(screen.getByText("the answer")).toBeInTheDocument();
  });

  it("span_io_panel_empty_when_absent", () => {
    render(<SpanIOPanel span={base} />);
    expect(screen.getByText("No input recorded")).toBeInTheDocument();
    expect(screen.getByText("No output recorded")).toBeInTheDocument();
  });

  it("span_io_panel_error_alert", () => {
    render(
      <SpanIOPanel
        span={{ ...base, statusCode: "2", statusMessage: "boom" }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
  });

  it("test_span_io_defaults_to_pretty", () => {
    // M29d: Pretty is the default — markdown is parsed (not shown raw).
    render(<SpanIOPanel span={{ ...base, inputValue: "**bold** ask" }} />);
    expect(screen.getByText("bold")).toBeInTheDocument();
    // the raw markdown asterisks are NOT present as literal text in Pretty mode
    expect(screen.queryByText("**bold** ask")).toBeNull();
    expect(screen.getByRole("button", { name: "Pretty" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("test_span_io_raw_shows_raw_string", async () => {
    render(<SpanIOPanel span={{ ...base, inputValue: "**bold** ask" }} />);
    await userEvent.click(screen.getByRole("button", { name: "Raw" }));
    // Raw shows the exact unrendered string (incl. the markdown asterisks)
    expect(screen.getByText("**bold** ask")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Raw" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("test_span_io_raw_escapes_html", async () => {
    // Security negative case: Raw renders a dangerous string as TEXT, never as HTML.
    render(
      <SpanIOPanel span={{ ...base, inputValue: "<script>alert(1)</script>" }} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Raw" }));
    // the literal string is visible as text, and NO script element was injected
    expect(
      screen.getByText("<script>alert(1)</script>"),
    ).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
  });
});
