import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SessionsListPage } from "./SessionsListPage.js";
import { SessionDetailPage } from "./SessionDetailPage.js";
import * as client from "../api/client.js";
import type { SessionDetail, SessionListResponse } from "../api/types.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return { ...actual, getSessions: vi.fn(), getSession: vi.fn() };
});

function renderAt(el: React.ReactNode, path = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{el}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const list: SessionListResponse = {
  sessions: [
    { sessionId: "S1", firstSeenAt: "2026-06-22T00:00:00.000Z", lastSeenAt: "2026-06-22T01:00:00.000Z", traceCount: 3, costUsd: 0.0125, totalTokens: 1500, errorRate: 0.25 },
  ],
};
const detail: SessionDetail = {
  sessionId: "S1",
  firstSeenAt: "2026-06-22T00:00:00.000Z",
  lastSeenAt: "2026-06-22T01:00:00.000Z",
  traceCount: 2,
  costUsd: 0.02,
  totalTokens: 300,
  errorRate: 0.5,
  latencyP50Ms: 12,
  latencyP95Ms: 88,
  traces: [{ traceId: "ta", name: "turn 1", durationMs: 12, statusCode: "ok" }],
};

beforeEach(() => vi.resetAllMocks());

describe("SessionsListPage (integration)", () => {
  it("test_sessions_list_page_renders_sessions", async () => {
    vi.mocked(client.getSessions).mockResolvedValue(list);
    renderAt(<SessionsListPage />);
    await waitFor(() => expect(screen.getByText("S1")).toBeInTheDocument());
    expect(screen.getByText("$0.0125")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
  });

  it("test_sessions_page_empty_and_error_states", async () => {
    // empty: documents the session.id requirement (honest fallback D3).
    vi.mocked(client.getSessions).mockResolvedValue({ sessions: [] });
    const { unmount } = renderAt(<SessionsListPage />);
    await waitFor(() => expect(screen.getByText(/session\.id/i)).toBeInTheDocument());
    unmount();
    // error: accessible alert.
    vi.mocked(client.getSessions).mockRejectedValue(new client.ApiError(500));
    renderAt(<SessionsListPage />);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Failed to load sessions"),
    );
  });
});

describe("SessionDetailPage (integration)", () => {
  it("test_session_detail_renders_metrics_and_member_traces", async () => {
    vi.mocked(client.getSession).mockResolvedValue(detail);
    renderAt(
      <Routes>
        <Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
      </Routes>,
      "/sessions/S1",
    );
    // scoped metrics
    await waitFor(() => expect(screen.getByText("$0.02")).toBeInTheDocument());
    expect(screen.getByText("50%")).toBeInTheDocument();
    // member trace list (reused M3 TraceList)
    expect(screen.getByText("turn 1")).toBeInTheDocument();
  });
});
