import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TraceList } from "./TraceList.js";
import type { TraceListItem } from "../api/types.js";

function renderInRouter(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("TraceList", () => {
  it("trace_list_renders_rows_with_links_and_empty_state", () => {
    const items: TraceListItem[] = [
      { traceId: "t1", name: "checkout", statusCode: "1", durationMs: 5, totalTokens: 20 },
      { traceId: "t2" },
    ];
    renderInRouter(<TraceList traces={items} />);
    // named row + link target
    const checkout = screen.getByText("checkout").closest("a")!;
    expect(checkout).toHaveAttribute("href", "/traces/t1");
    // fallback to traceId when no name
    expect(screen.getByText("t2").closest("a")).toHaveAttribute("href", "/traces/t2");
  });

  it("trace_list_renders_empty_state_when_no_traces", () => {
    renderInRouter(<TraceList traces={[]} />);
    expect(screen.getByText("No executions yet")).toBeInTheDocument();
  });
});
