import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { DashboardPage } from "./DashboardPage.js";
import * as client from "../api/client.js";
import type { ObservabilityResponse } from "../api/types.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return { ...actual, getObservability: vi.fn(), getNorthStar: vi.fn() };
});

const obs: ObservabilityResponse = {
  range: "24h",
  traffic: [
    { periodStart: "2026-06-22T00:00:00.000Z", traceCount: 8, errorCount: 2, errorRate: 0.25 },
    { periodStart: "2026-06-22T01:00:00.000Z", traceCount: 5, errorCount: 0, errorRate: 0 },
  ],
  latency: [
    { periodStart: "2026-06-22T00:00:00.000Z", p50Ms: 12, p75Ms: 30, p95Ms: 88, p99Ms: 140 },
    { periodStart: "2026-06-22T01:00:00.000Z", p50Ms: 14, p75Ms: 33, p95Ms: 90, p99Ms: 150 },
  ],
  tokensByModel: [
    { periodStart: "2026-06-22T00:00:00.000Z", model: "gpt-4o", totalTokens: 1500, costUsd: 0.0125 },
  ],
};
const northStar = {
  tracesPerDay: [{ period: "2026-06-22", count: 7 }],
  replaySessionsPerWeek: [{ period: "2026-06-15", count: 3 }],
};

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(client.getNorthStar).mockResolvedValue(northStar);
});

describe("DashboardPage (M20 Pinned Charts)", () => {
  it("metrics_dashboard_chart_type_toggle_switches_views", async () => {
    vi.mocked(client.getObservability).mockResolvedValue(obs);
    const { container } = renderPage();
    // default = Line → polylines, no bars
    await waitFor(() => expect(container.querySelector("polyline")).not.toBeNull());
    expect(container.querySelector("rect")).toBeNull();
    // Stacked bar → rects appear
    await userEvent.click(screen.getByRole("tab", { name: "Stacked bar" }));
    await waitFor(() => expect(container.querySelector("rect")).not.toBeNull());
    // Distribution → latency 4 percentile bands (≥4 polylines)
    await userEvent.click(screen.getByRole("tab", { name: "Distribution" }));
    await waitFor(() =>
      expect(container.querySelectorAll("polyline").length).toBeGreaterThanOrEqual(4),
    );
  });

  it("metrics_dashboard_rehomes_north_star", async () => {
    vi.mocked(client.getObservability).mockResolvedValue(obs);
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "North-star" })).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("region", { name: "Traces ingested / day" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Replay sessions / week" }),
    ).toBeInTheDocument();
  });

  it("metrics_dashboard_range_toggle_preserved", async () => {
    vi.mocked(client.getObservability).mockResolvedValue(obs);
    renderPage();
    await waitFor(() => expect(client.getObservability).toHaveBeenCalledWith("24h"));
    await userEvent.click(screen.getByRole("tab", { name: "7d" }));
    await waitFor(() => expect(client.getObservability).toHaveBeenCalledWith("7d"));
  });

  it("metrics_dashboard_renders_pinned_cards", async () => {
    vi.mocked(client.getObservability).mockResolvedValue(obs);
    renderPage();
    // the four pinned cards (migrated from ObservabilityPage assertions)
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Traffic" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("region", { name: "Span Latency" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Tokens" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Cost" })).toBeInTheDocument();
    // latency P99 inline stat + cost total
    expect(screen.getByText("150 ms")).toBeInTheDocument();
    expect(screen.getByText("$0.0125")).toBeInTheDocument();
  });

  it("metrics_dashboard_fetch_error_is_fail_soft", async () => {
    // observability rejects → cards render empty, dashboard does NOT crash/alert
    vi.mocked(client.getObservability).mockRejectedValue(new client.ApiError(500));
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Pinned Charts" })).toBeInTheDocument(),
    );
    // a card shows the empty/fail-soft message; north-star still renders
    expect(screen.getAllByText("No data in range").length).toBeGreaterThan(0);
    expect(screen.getByRole("region", { name: "Traces ingested / day" })).toBeInTheDocument();
  });

  it("metrics_dashboard_north_star_empty_is_fail_soft", async () => {
    // north-star empty (migrated from the deleted NorthStarPage empty-state test):
    // empty arrays → the north-star cards show the empty message, rest renders.
    vi.mocked(client.getObservability).mockResolvedValue(obs);
    vi.mocked(client.getNorthStar).mockResolvedValue({
      tracesPerDay: [],
      replaySessionsPerWeek: [],
    });
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByRole("region", { name: "Traces ingested / day" }),
      ).toBeInTheDocument(),
    );
    // both north-star cards show the empty message
    expect(screen.getAllByText("No data in range").length).toBeGreaterThanOrEqual(2);
  });

  it("metrics_dashboard_north_star_error_is_fail_soft", async () => {
    // north-star fetch rejects → its cards empty, observability cards still render.
    vi.mocked(client.getObservability).mockResolvedValue(obs);
    vi.mocked(client.getNorthStar).mockRejectedValue(new client.ApiError(500));
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Traffic" })).toBeInTheDocument(),
    );
    expect(
      screen.getByRole("region", { name: "Traces ingested / day" }),
    ).toBeInTheDocument();
  });

  it("metrics_route_redirects_to_dashboards", async () => {
    vi.mocked(client.getObservability).mockResolvedValue(obs);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/metrics"]}>
          <Routes>
            <Route path="/metrics" element={<Navigate to="/dashboards" replace />} />
            <Route path="/dashboards" element={<DashboardPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Pinned Charts" })).toBeInTheDocument(),
    );
  });
});
