import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider, violetForge } from "@theokit/ui";
import { SpanInfoPanel } from "./SpanInfoPanel.js";
import type { SpanNodeData } from "../api/types.js";

function withTheme(ui: React.ReactNode) {
  return (
    <ThemeProvider defaultTheme="violet-forge" defaultMode="dark" themes={[violetForge]}>
      {ui}
    </ThemeProvider>
  );
}

const rich: SpanNodeData = {
  spanId: "s1",
  traceId: "t1",
  name: "ChatOpenAI",
  startTimeUnixNano: "1700000000000000000",
  endTimeUnixNano: "1700000000500000000",
  statusCode: "1",
  model: "gpt-4o",
  provider: "openai",
  inputTokens: 100,
  outputTokens: 50,
  attributes: { "gen_ai.operation.name": "chat", foo: "bar" },
  events: [{ name: "first_token", attributes: { ms: 42 } }],
};

describe("SpanInfoPanel", () => {
  it("span_info_panel_trace_info_shows_model_tokens_status", () => {
    render(withTheme(<SpanInfoPanel span={rich} />));
    // kind badge derived from gen_ai.operation.name=chat → llm
    expect(screen.getByText("llm")).toBeInTheDocument();
    expect(screen.getByText(/gpt-4o/)).toBeInTheDocument();
    expect(screen.getByText(/openai/)).toBeInTheDocument();
    expect(screen.getByText(/in 100 \/ out 50/)).toBeInTheDocument();
  });

  it("span_info_panel_attributes_and_events_tabs", async () => {
    const user = userEvent.setup();
    render(withTheme(<SpanInfoPanel span={rich} />));
    await user.click(screen.getByRole("tab", { name: "Attributes" }));
    // the JsonBlock pre contains the attribute value (avoids the "Attributes" tab/summary clash)
    expect(screen.getByText(/"foo"/)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Events" }));
    expect(screen.getByText("first_token")).toBeInTheDocument(); // event JsonBlock summary
  });

  it("span_info_panel_empty_states", () => {
    const bare: SpanNodeData = {
      spanId: "s2",
      traceId: "t1",
      name: "empty",
      startTimeUnixNano: "1700000000000000000",
      endTimeUnixNano: "1700000000000000000",
    };
    render(withTheme(<SpanInfoPanel span={bare} />));
    // Trace Info tab is default; model + tokens show EmptyStates (backward-compat)
    expect(screen.getByText("No model recorded")).toBeInTheDocument();
    expect(screen.getByText("No token usage")).toBeInTheDocument();
  });
});
