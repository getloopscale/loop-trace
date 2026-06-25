import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { TraceListPage } from "./TraceListPage.js";
import { RangeProvider } from "../hooks/useRange.js";
import * as client from "../api/client.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return {
    ...actual,
    getTraceTree: vi.fn(),
    listTraces: vi.fn(),
    // M18: the page now renders the TraceSummaryStrip (useObservability).
    getObservability: vi.fn().mockResolvedValue({
      range: "24h",
      traffic: [],
      latency: [],
      tokensByModel: [],
    }),
  };
});

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <RangeProvider>
        <MemoryRouter>
          <TraceListPage />
        </MemoryRouter>
      </RangeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

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

  it("test_trace_list_datatable_header_sort_forwards_orderby", async () => {
    vi.mocked(client.listTraces).mockResolvedValue({
      traces: [{ traceId: "t1", name: "checkout", durationMs: 5 }],
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("checkout")).toBeInTheDocument());
    // M18: sorting is owned by the DataTable column headers (Arize-style), bound
    // to the same orderBy/dir query — clicking a header refetches with that orderBy.
    // (The asc→desc→none cycle itself is the DataTable's behavior, tested upstream.)
    // Target the sortable header button specifically — "Latency" now also appears
    // as a ColumnToggle checkbox label (M29d), so disambiguate by the button role.
    await userEvent.click(screen.getByRole("button", { name: "Latency" }));
    // the page maps the DataTable sort → M9 query, forwarding BOTH orderBy + dir
    // (first click = asc, the design system's standard sort cycle).
    await waitFor(() =>
      expect(client.listTraces).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: "latency", dir: "asc" }),
      ),
    );
  });

  it("test_global_range_drives_list_from_to_iso", async () => {
    // M29b: time is the global date-range (default 7d) — the list query carries an
    // ISO from/to window derived from the preset (no toolbar From/To inputs).
    vi.mocked(client.listTraces).mockResolvedValue({ traces: [] });
    renderPage();
    await waitFor(() =>
      expect(client.listTraces).toHaveBeenCalledWith(
        expect.objectContaining({
          from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        }),
      ),
    );
    // the toolbar From/To inputs are gone (one global time control)
    expect(screen.queryByLabelText("from time")).toBeNull();
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

  it("test_trace_export_href_default_carries_csv_and_cap_limit", async () => {
    vi.mocked(client.listTraces).mockResolvedValue({ traces: [] });
    renderPage();
    // Even with no filter, the export href carries format=csv + the cap limit.
    const href = screen.getByText("Export CSV").getAttribute("href") ?? "";
    expect(href).toContain("format=csv");
    expect(href).toContain("limit=500"); // EC-4
  });

  it("test_trace_export_href_carries_current_query", async () => {
    vi.mocked(client.listTraces).mockResolvedValue({ traces: [] });
    renderPage();
    await userEvent.selectOptions(
      screen.getByLabelText("status filter"),
      "error",
    );
    const href = screen.getByText("Export CSV").getAttribute("href") ?? "";
    expect(href).toContain("status=error");
    expect(href).toContain("format=csv");
    expect(href).toContain("limit=500");
  });

  it("test_trace_export_href_carries_global_time_window", async () => {
    // M29b review F-arch-1: the CSV export must honour the global date range, not
    // just the toolbar filters. The href carries the effective from/to ISO window.
    vi.mocked(client.listTraces).mockResolvedValue({ traces: [] });
    renderPage();
    await waitFor(() => expect(client.listTraces).toHaveBeenCalled());
    const href = screen.getByText("Export CSV").getAttribute("href") ?? "";
    expect(href).toMatch(/from=\d{4}-\d{2}-\d{2}T/);
    expect(href).toMatch(/to=\d{4}-\d{2}-\d{2}T/);
  });

  it("test_column_toggle_hides_a_column", async () => {
    // M29d: unchecking a column in the Columns menu removes it from the table.
    vi.mocked(client.listTraces).mockResolvedValue({
      traces: [{ traceId: "t1", name: "checkout", costUsd: 0.01 }],
    });
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("columnheader", { name: "Cost" })).toBeInTheDocument(),
    );
    // open the Columns disclosure, then uncheck "Cost"
    await userEvent.click(screen.getByText("Columns"));
    await userEvent.click(screen.getByRole("checkbox", { name: "Cost" }));
    await waitFor(() =>
      expect(screen.queryByRole("columnheader", { name: "Cost" })).toBeNull(),
    );
    // Name is never offered for hiding (always-on)
    expect(screen.queryByRole("checkbox", { name: "Name" })).toBeNull();
  });

  it("test_saved_view_apply_refetches_list_with_view_filters", async () => {
    // M29b review F-test-2 / T2.2 DoD: applying a saved view through the real page
    // mutates the query and refetches listTraces with the view's filters, while the
    // global time window (from/to ISO) is preserved (time is never part of a view).
    vi.mocked(client.listTraces).mockResolvedValue({ traces: [] });
    renderPage();
    await waitFor(() => expect(client.listTraces).toHaveBeenCalled());

    // 1. set a filter, 2. save it as a named view
    await userEvent.selectOptions(screen.getByLabelText("status filter"), "error");
    await userEvent.type(screen.getByLabelText("view name"), "prod errors");
    await userEvent.click(screen.getByRole("button", { name: "Save view" }));

    // 3. clear the filter, 4. apply the saved view → status returns + time stays global
    await userEvent.selectOptions(screen.getByLabelText("status filter"), "");
    await userEvent.selectOptions(
      screen.getByLabelText("saved views"),
      "prod errors",
    );
    await waitFor(() =>
      expect(client.listTraces).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "error",
          from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          to: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        }),
      ),
    );
  });
});
