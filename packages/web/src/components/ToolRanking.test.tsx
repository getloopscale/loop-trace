import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ToolRanking } from "./ToolRanking.js";
import type { ToolStat } from "../api/types.js";

const tools: ToolStat[] = [
  { toolName: "search", callCount: 9, errorCount: 1, errorRate: 0.111, p50Ms: 12, p95Ms: 40 },
  { toolName: "slow-fetch", callCount: 3, errorCount: 0, errorRate: 0, p50Ms: 5, p95Ms: 900 },
];

function renderInRouter(ui: React.ReactNode) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

describe("ToolRanking", () => {
  it("tool_ranking_renders_rows_sorts_and_empty_state", async () => {
    renderInRouter(<ToolRanking tools={tools} />);
    // row link to drill-down
    expect(screen.getByText("search").closest("a")).toHaveAttribute("href", "/tools/search");

    // default sort by callCount DESC → search (9) before slow-fetch (3)
    let rows = screen.getAllByRole("row").slice(1); // drop header
    expect(rows[0]).toHaveTextContent("search");

    // sort by p95 → slow-fetch (900) first
    await userEvent.click(screen.getByRole("button", { name: "p95 (ms)" }));
    rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("slow-fetch");
  });

  it("tool_ranking_renders_empty_state", () => {
    renderInRouter(<ToolRanking tools={[]} />);
    expect(screen.getByText("No tool calls yet")).toBeInTheDocument();
  });
});
