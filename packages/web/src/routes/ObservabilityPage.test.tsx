import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ObservabilityPage } from "./ObservabilityPage.js";
import * as client from "../api/client.js";
import type { ObservabilityResponse } from "../api/types.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return { ...actual, getObservability: vi.fn() };
});

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ObservabilityPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const resp: ObservabilityResponse = {
  range: "24h",
  traffic: [
    { periodStart: "2026-06-22T00:00:00.000Z", traceCount: 8, errorCount: 2, errorRate: 0.25 },
  ],
  latency: [
    { periodStart: "2026-06-22T00:00:00.000Z", p50Ms: 12, p75Ms: 30, p95Ms: 88, p99Ms: 140 },
  ],
  tokensByModel: [
    { periodStart: "2026-06-22T00:00:00.000Z", model: "gpt-4o", totalTokens: 1500, costUsd: 0.0125 },
  ],
};

beforeEach(() => vi.resetAllMocks());

describe("ObservabilityPage (integration)", () => {
  it("test_observability_page_renders_metric_tables", async () => {
    vi.mocked(client.getObservability).mockResolvedValue(resp);
    renderPage();
    // Traffic table: error-rate rendered as a percentage.
    await waitFor(() => expect(screen.getByText("25%")).toBeInTheDocument());
    // Latency table: p99 value present.
    expect(screen.getByText("140 ms")).toBeInTheDocument();
    // Tokens-by-model table: the model + its cost.
    expect(screen.getByText("gpt-4o")).toBeInTheDocument();
    expect(screen.getByText("$0.0125")).toBeInTheDocument();
  });

  it("test_observability_range_change_refetches", async () => {
    vi.mocked(client.getObservability).mockResolvedValue(resp);
    renderPage();
    await waitFor(() => expect(client.getObservability).toHaveBeenCalledWith("24h"));
    await userEvent.click(screen.getByRole("radio", { name: "7d" }));
    await waitFor(() => expect(client.getObservability).toHaveBeenCalledWith("7d"));
  });

  it("test_observability_page_empty_and_error_states", async () => {
    // Empty: a successful response with no buckets shows an accessible empty state.
    vi.mocked(client.getObservability).mockResolvedValue({
      range: "24h",
      traffic: [],
      latency: [],
      tokensByModel: [],
    });
    const { unmount } = renderPage();
    await waitFor(() =>
      expect(screen.getAllByText(/No .* yet/i).length).toBeGreaterThan(0),
    );
    unmount();

    // Error: a rejected response shows the accessible alert.
    vi.mocked(client.getObservability).mockRejectedValue(new client.ApiError(500));
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Failed to load observability",
      ),
    );
  });
});
