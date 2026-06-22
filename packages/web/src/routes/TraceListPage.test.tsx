import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

  it("test_trace_filters_change_refetches_with_param", async () => {
    vi.mocked(client.listTraces).mockResolvedValue({ traces: [] });
    renderPage();
    await waitFor(() => expect(client.listTraces).toHaveBeenCalled());
    await userEvent.selectOptions(
      screen.getByLabelText("status filter"),
      "error",
    );
    await waitFor(() =>
      expect(client.listTraces).toHaveBeenCalledWith(
        expect.objectContaining({ status: "error" }),
      ),
    );
  });

  it("test_trace_list_sort_header_sets_aria_sort", async () => {
    vi.mocked(client.listTraces).mockResolvedValue({ traces: [] });
    renderPage();
    await waitFor(() => expect(client.listTraces).toHaveBeenCalled());
    const latency = screen.getByRole("columnheader", { name: /Latency/ });
    await userEvent.click(latency);
    await waitFor(() =>
      expect(client.listTraces).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: "latency" }),
      ),
    );
    expect(
      screen.getByRole("columnheader", { name: /Latency/ }),
    ).toHaveAttribute("aria-sort", "descending");
  });

  it("test_trace_list_renders_ok_error_status_indicator", async () => {
    vi.mocked(client.listTraces).mockResolvedValue({
      traces: [{ traceId: "t1", name: "checkout", statusCode: "error" }],
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText("status: error")).toBeInTheDocument(),
    );
    // not the raw OTel code
    expect(screen.queryByText("2")).not.toBeInTheDocument();
  });

  it("test_trace_export_href_carries_current_query_and_cap_limit", async () => {
    vi.mocked(client.listTraces).mockResolvedValue({ traces: [] });
    renderPage();
    await userEvent.selectOptions(
      screen.getByLabelText("status filter"),
      "error",
    );
    const href = screen.getByText("Export CSV").getAttribute("href") ?? "";
    expect(href).toContain("status=error");
    expect(href).toContain("format=csv");
    expect(href).toContain("limit=500"); // EC-4: export the full filtered set, not one page
  });
});
