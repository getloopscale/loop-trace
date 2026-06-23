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

  const bare: SpanNodeData = {
    spanId: "s2",
    traceId: "t1",
    name: "empty",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000000000000",
  };

  it("span_info_panel_empty_states", () => {
    render(withTheme(<SpanInfoPanel span={bare} />));
    // Trace Info tab is default; model + tokens show EmptyStates (backward-compat)
    expect(screen.getByText("No model recorded")).toBeInTheDocument();
    expect(screen.getByText("No token usage")).toBeInTheDocument();
  });

  it("span_info_panel_empty_attributes_and_events_tabs", async () => {
    // backward-compat: the Attributes/Events EmptyStates (behind tabs) still show
    // for a span with none (migrated from the deleted SpanDetail.test).
    const user = userEvent.setup();
    render(withTheme(<SpanInfoPanel span={bare} />));
    await user.click(screen.getByRole("tab", { name: "Attributes" }));
    expect(screen.getByText("No attributes")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Events" }));
    expect(screen.getByText("No events")).toBeInTheDocument();
  });

  it("span_info_panel_error_status_indicated", () => {
    render(withTheme(<SpanInfoPanel span={{ ...bare, statusCode: "2" }} />));
    // the Trace Info tab surfaces the status via an aria-label (M9 a11y contract)
    expect(screen.getByLabelText("status: 2")).toBeInTheDocument();
  });

  it("span_info_panel_pretty_prints_nested_attribute", async () => {
    const user = userEvent.setup();
    render(
      withTheme(
        <SpanInfoPanel
          span={{ ...bare, attributes: { msg: { role: "user" } } }}
        />,
      ),
    );
    await user.click(screen.getByRole("tab", { name: "Attributes" }));
    // nested object is pretty-printed by JsonBlock (not "[object Object]")
    expect(screen.getByText(/"role": "user"/)).toBeInTheDocument();
  });

  it("span_info_panel_keeps_active_tab_across_span_change", async () => {
    // EC-2: switching the selected span keeps the chosen tab (local state, no remount).
    const user = userEvent.setup();
    const { rerender } = render(withTheme(<SpanInfoPanel span={rich} />));
    await user.click(screen.getByRole("tab", { name: "Attributes" }));
    expect(screen.getByText(/"foo"/)).toBeInTheDocument();
    rerender(
      withTheme(<SpanInfoPanel span={{ ...rich, spanId: "s9", name: "other" }} />),
    );
    // still on the Attributes tab (Attributes trigger remains selected)
    expect(screen.getByRole("tab", { name: "Attributes" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
