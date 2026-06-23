import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { TraceListPage } from "./TraceListPage.js";
import { AutoRefreshProvider } from "../hooks/useAutoRefresh.js";
import * as client from "../api/client.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return { ...actual, getTraceTree: vi.fn(), listTraces: vi.fn() };
});

function renderWithProvider() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AutoRefreshProvider>
        <MemoryRouter>
          <TraceListPage />
        </MemoryRouter>
      </AutoRefreshProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
});

describe("TraceListPage auto-refresh wiring (T3.2)", () => {
  it("trace_list_page_shows_auto_refresh_control", () => {
    vi.mocked(client.listTraces).mockResolvedValue({ traces: [] });
    renderWithProvider();
    expect(screen.getByLabelText("Auto-refresh")).toBeInTheDocument();
  });

  it("app_mounts_provider", async () => {
    vi.mocked(client.listTraces).mockResolvedValue({ traces: [] });
    const user = userEvent.setup();
    renderWithProvider();
    await user.selectOptions(screen.getByLabelText("Auto-refresh"), "10s");
    expect(localStorage.getItem("theolens.autoRefreshMs")).toBe("10000");
  });
});
