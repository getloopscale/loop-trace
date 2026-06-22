import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { NorthStarPage } from "./NorthStarPage.js";
import * as client from "../api/client.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return { ...actual, getNorthStar: vi.fn() };
});

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <NorthStarPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.resetAllMocks());

describe("NorthStarPage (M8 DoD #3)", () => {
  it("test_north_star_page_renders_traces_per_day_and_sessions_per_week", async () => {
    vi.mocked(client.getNorthStar).mockResolvedValue({
      tracesPerDay: [{ period: "2026-06-22", count: 7 }],
      replaySessionsPerWeek: [{ period: "2026-06-15", count: 3 }],
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Traces ingested per day")).toBeInTheDocument(),
    );
    expect(screen.getByText("Replay sessions per week")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("test_north_star_page_renders_empty_state", async () => {
    vi.mocked(client.getNorthStar).mockResolvedValue({
      tracesPerDay: [],
      replaySessionsPerWeek: [],
    });
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByText(/no traces ingested per day yet/i),
      ).toBeInTheDocument(),
    );
  });
});
