import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SpanIOPanel } from "./SpanIOPanel.js";
import type { SpanNodeData } from "../api/types.js";

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
    // markdown is parsed (heading element), not shown raw
    expect(
      screen.getByRole("heading", { name: "Prompt" }),
    ).toBeInTheDocument();
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
});
