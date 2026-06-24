import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { SessionDetailPage } from "./SessionDetailPage.js";
import * as client from "../api/client.js";
import type { SessionDetail } from "../api/types.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return { ...actual, getSession: vi.fn() };
});

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={["/sessions/s1"]}>
        <Routes>
          <Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const detail: SessionDetail = {
  sessionId: "s1",
  firstSeenAt: "2026-06-20T00:00:00.000Z",
  lastSeenAt: "2026-06-20T00:05:00.000Z",
  traceCount: 7,
  costUsd: 0.0125,
  totalTokens: 1500,
  errorRate: 0.1,
  latencyP50Ms: 120,
  latencyP95Ms: 800,
  traces: [],
};

beforeEach(() => vi.resetAllMocks());

describe("SessionDetailPage", () => {
  it("test_session_metrics_render_stat_tiles", async () => {
    vi.mocked(client.getSession).mockResolvedValue(detail);
    const { container } = renderPage();
    // metric tiles render their labels + formatted values (StatTile grid, dark)
    await waitFor(() =>
      expect(screen.getByText("Traces")).toBeInTheDocument(),
    );
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("Cost")).toBeInTheDocument();
    expect(screen.getByText("$0.0125")).toBeInTheDocument();
    expect(screen.getByText("Error rate")).toBeInTheDocument();
    expect(screen.getByText("Latency p95")).toBeInTheDocument();
    // no legacy session-metrics dl
    expect(container.querySelector(".session-metrics")).toBeNull();
  });

  it("session_detail_renders_error_when_not_found", async () => {
    vi.mocked(client.getSession).mockRejectedValue(new client.ApiError(404));
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Session not found"),
    );
  });
});
