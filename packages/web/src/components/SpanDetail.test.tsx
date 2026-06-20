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
});
