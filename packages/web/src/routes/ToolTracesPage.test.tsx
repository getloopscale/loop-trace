import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ToolTracesPage } from "./ToolTracesPage.js";
import * as client from "../api/client.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return { ...actual, getTracesForTool: vi.fn() };
});

function renderAt(path: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/tools/:toolName" element={<ToolTracesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.resetAllMocks());

describe("ToolTracesPage (integration)", () => {
  it("tool_traces_page_renders_drilldown_executions", async () => {
    vi.mocked(client.getTracesForTool).mockResolvedValue({
      traces: [{ traceId: "t1", name: "checkout" }],
    });
    renderAt("/tools/search");
    await waitFor(() =>
      expect(screen.getByText("checkout").closest("a")).toHaveAttribute("href", "/traces/t1"),
    );
    // the tool name appears in the heading
    expect(screen.getByRole("heading")).toHaveTextContent("search");
  });

  it("tool_traces_page_renders_empty_when_no_executions", async () => {
    vi.mocked(client.getTracesForTool).mockResolvedValue({ traces: [] });
    renderAt("/tools/unused");
    await waitFor(() =>
      expect(screen.getByText("No executions yet")).toBeInTheDocument(),
    );
  });
});
