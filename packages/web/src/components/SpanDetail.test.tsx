import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SpanDetail } from "./SpanDetail.js";
import type { SpanNodeData } from "../api/types.js";

const base: SpanNodeData = {
  spanId: "s",
  traceId: "t",
  name: "checkout",
  startTimeUnixNano: "0",
  endTimeUnixNano: "5000000",
};

describe("SpanDetail", () => {
  it("span_detail_shows_model_provider_tokens_and_attributes", () => {
    render(
      <SpanDetail
        span={{
          ...base,
          model: "gpt-4o",
          provider: "openai",
          inputTokens: 12,
          outputTokens: 8,
          statusCode: "1",
          attributes: { "gen_ai.tool.name": "search-products" },
        }}
      />,
    );
    expect(screen.getByText("checkout")).toBeInTheDocument();
    expect(screen.getByText(/gpt-4o/)).toBeInTheDocument();
    expect(screen.getByText(/openai/)).toBeInTheDocument();
    expect(screen.getByText(/in 12 \/ out 8/)).toBeInTheDocument();
    expect(screen.getByText(/gen_ai\.tool\.name/)).toBeInTheDocument();
  });

  it("span_detail_shows_error_section_when_status_error", () => {
    render(
      <SpanDetail span={{ ...base, name: "boom", statusCode: "2", statusMessage: "kaboom" }} />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("kaboom");
  });

  it("span_detail_empty_sections_when_no_genai_data", () => {
    render(<SpanDetail span={{ ...base, name: "plain" }} />);
    expect(screen.getByText("No model recorded")).toBeInTheDocument();
    expect(screen.getByText("No token usage")).toBeInTheDocument();
    expect(screen.getByText("No attributes")).toBeInTheDocument();
  });

  it("span_detail_pretty_prints_nested_attributes", () => {
    render(
      <SpanDetail
        span={{
          ...base,
          attributes: {
            "gen_ai.input.messages": [{ role: "user", content: "hi" }],
          },
        }}
      />,
    );
    expect(screen.getByText(/gen_ai\.input\.messages/)).toBeInTheDocument();
    expect(screen.getByText(/"role": "user"/)).toBeInTheDocument();
  });

  it("span_detail_never_throws_on_non_serializable_attribute", () => {
    // A BigInt would make JSON.stringify throw; JsonBlock guards it (no crash).
    expect(() =>
      render(
        <SpanDetail span={{ ...base, attributes: { big: 10n as unknown } }} />,
      ),
    ).not.toThrow();
  });

  it("test_span_detail_renders_input_output_events_sections", () => {
    const { container } = render(
      <SpanDetail
        span={{
          ...base,
          inputValue: "# Prompt\n\nwhat is 2+2?",
          outputValue: "The answer is **4**.",
          events: [{ name: "chunk", attributes: { i: 1 } }],
        }}
      />,
    );
    // input/output rendered as markdown (heading + bold), not raw.
    expect(container.querySelector("h1")?.textContent).toBe("Prompt");
    expect(container.querySelector("strong")?.textContent).toBe("4");
    // events section lists the event by name.
    expect(screen.getByText("chunk")).toBeInTheDocument();
  });

  it("test_span_detail_backward_compatible_empty_sections", () => {
    // A span without input/output/events shows EmptyStates, no crash (DoD#3).
    expect(() => render(<SpanDetail span={{ ...base, name: "plain" }} />)).not.toThrow();
    expect(screen.getByText("No input recorded")).toBeInTheDocument();
    expect(screen.getByText("No output recorded")).toBeInTheDocument();
    expect(screen.getByText("No events")).toBeInTheDocument();
    expect(screen.getByText("No attributes")).toBeInTheDocument();
  });
});
