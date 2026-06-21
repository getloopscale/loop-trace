import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ToolAnalyticsPage } from "./ToolAnalyticsPage.js";
import * as client from "../api/client.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return { ...actual, getToolStats: vi.fn() };
});

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ToolAnalyticsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.resetAllMocks());

describe("ToolAnalyticsPage (integration)", () => {
  it("tool_analytics_page_renders_ranking", async () => {
    vi.mocked(client.getToolStats).mockResolvedValue({
      tools: [
        { toolName: "search", callCount: 9, errorCount: 1, errorRate: 0.111, p50Ms: 12, p95Ms: 40 },
      ],
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("search").closest("a")).toHaveAttribute("href", "/tools/search"),
    );
    expect(screen.getByText("11.1%")).toBeInTheDocument();
  });

  it("tool_analytics_page_renders_error_state", async () => {
    vi.mocked(client.getToolStats).mockRejectedValue(new client.ApiError(500));
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Failed to load tool analytics"),
    );
  });
});
