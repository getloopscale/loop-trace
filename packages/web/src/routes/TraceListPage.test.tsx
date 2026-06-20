import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { TraceListPage } from "./TraceListPage.js";
import * as client from "../api/client.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return { ...actual, getTraceTree: vi.fn(), listTraces: vi.fn() };
});

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <TraceListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.resetAllMocks());

describe("TraceListPage (integration)", () => {
  it("trace_list_page_renders_executions_from_api", async () => {
    vi.mocked(client.listTraces).mockResolvedValue({
      traces: [{ traceId: "t1", name: "checkout", durationMs: 5 }],
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("checkout").closest("a")).toHaveAttribute(
        "href",
        "/traces/t1",
      ),
    );
  });

  it("trace_list_page_renders_empty_state_when_no_executions", async () => {
    vi.mocked(client.listTraces).mockResolvedValue({ traces: [] });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("No executions yet")).toBeInTheDocument(),
    );
  });

  it("trace_list_page_renders_error_state_on_api_failure", async () => {
    vi.mocked(client.listTraces).mockRejectedValue(new client.ApiError(500));
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Failed to load executions",
      ),
    );
  });

  it("trace_list_page_renders_error_state_on_network_rejection", async () => {
    // fetch rejects (unreachable / offline) → no unhandled rejection, ErrorState shown.
    vi.mocked(client.listTraces).mockRejectedValue(new TypeError("fetch failed"));
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Failed to load executions",
      ),
    );
  });
});
