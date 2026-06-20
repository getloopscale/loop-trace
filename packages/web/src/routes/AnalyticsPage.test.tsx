import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AnalyticsPage } from "./AnalyticsPage.js";
import * as client from "../api/client.js";
import type { CostByPeriodResponse } from "../api/types.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return { ...actual, getCostByPeriod: vi.fn() };
});

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AnalyticsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const dayResp: CostByPeriodResponse = {
  period: "day",
  buckets: [{ periodStart: "2026-06-20T00:00:00.000Z", costUsd: 0.0125, totalTokens: 1500, traceCount: 3 }],
};
const weekResp: CostByPeriodResponse = {
  period: "week",
  buckets: [{ periodStart: "2026-06-15T00:00:00.000Z", costUsd: 0.9, totalTokens: 90000, traceCount: 42 }],
};

beforeEach(() => vi.resetAllMocks());

describe("AnalyticsPage (integration)", () => {
  it("analytics_page_renders_period_buckets_and_toggles_day_week", async () => {
    vi.mocked(client.getCostByPeriod).mockImplementation(async (p) =>
      p === "week" ? weekResp : dayResp,
    );
    renderPage();
    // default day bucket
    await waitFor(() => expect(screen.getByText("$0.0125")).toBeInTheDocument());
    // toggle to week → refetches with the week data
    await userEvent.click(screen.getByText("Week"));
    await waitFor(() => expect(screen.getByText("$0.90")).toBeInTheDocument());
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("analytics_page_renders_error_state_on_api_failure", async () => {
    vi.mocked(client.getCostByPeriod).mockRejectedValue(new client.ApiError(500));
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Failed to load cost analytics"),
    );
  });
});
