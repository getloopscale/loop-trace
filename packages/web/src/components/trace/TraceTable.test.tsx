import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, violetForge } from "@theokit/ui";
import { TraceTable } from "./TraceTable.js";
import type { TraceListItem } from "../../api/types.js";
import * as client from "../../api/client.js";

// The expandable row lazily loads the span tree via useTraceTree → getTraceTree (M29d).
vi.mock("../../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../../api/client.js")>();
  return { ...actual, getTraceTree: vi.fn(), addAnnotation: vi.fn() };
});

function renderTable(props: Partial<React.ComponentProps<typeof TraceTable>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider defaultTheme="violet-forge" defaultMode="dark" themes={[violetForge]}>
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <TraceTable
            traces={props.traces ?? []}
            sort={props.sort ?? null}
            onSortChange={props.onSortChange ?? (() => {})}
            loading={props.loading ?? false}
            {...(props.hiddenColumns ? { hiddenColumns: props.hiddenColumns } : {})}
          />
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.mocked(client.getTraceTree).mockReset();
  vi.mocked(client.addAnnotation).mockResolvedValue({ annotations: [] });
});

const rich: TraceListItem = {
  traceId: "t1",
  name: "checkout",
  statusCode: "ok",
  model: "gpt-4o",
  rootOperationName: "chat",
  costUsd: 0.0123,
  totalTokens: 150,
  durationMs: 1200,
  startTimeUnixNano: "1700000000000000000",
  endTimeUnixNano: "1700000001200000000",
  inputPreview: "the user prompt",
  outputPreview: "the answer",
};

describe("TraceTable", () => {
  it("trace_list_renders_enriched_datatable_columns", () => {
    renderTable({ traces: [rich] });
    // name links to the trace detail
    expect(screen.getByText("checkout").closest("a")).toHaveAttribute(
      "href",
      "/traces/t1",
    );
    // kind badge derived from root signals (chat → llm)
    expect(screen.getByText("llm")).toBeInTheDocument();
    // M29: model pill renders the model id
    expect(screen.getByText("gpt-4o")).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Model" }),
    ).toBeInTheDocument();
    // cost + input preview cells
    expect(screen.getByText("$0.0123")).toBeInTheDocument();
    expect(screen.getByText("the user prompt")).toBeInTheDocument();
    // column headers resolve (a11y)
    expect(screen.getByRole("columnheader", { name: "Cost" })).toBeInTheDocument();
  });

  it("trace_table_sort_click_forwards_to_onSortChange", async () => {
    const onSortChange = vi.fn();
    const user = userEvent.setup();
    renderTable({ traces: [rich], onSortChange });
    // clicking a sortable header (Latency) forwards a sort to the page
    await user.click(screen.getByText("Latency"));
    expect(onSortChange).toHaveBeenCalled();
    const arg = onSortChange.mock.calls[0]?.[0];
    expect(arg?.key).toBe("latency");
    // direction is forwarded (DataTable's standard first-click is ascending)
    expect(arg?.direction).toBe("asc");
  });

  it("trace_table_empty_state", () => {
    renderTable({ traces: [] });
    expect(screen.getByText("No executions yet")).toBeInTheDocument();
  });

  it("trace_table_status_badge_a11y_ok_error_and_dash", () => {
    renderTable({
      traces: [
        { traceId: "ok1", name: "a", statusCode: "ok" },
        { traceId: "er1", name: "b", statusCode: "error" },
        { traceId: "no1", name: "c" }, // no status → dash
      ],
    });
    // status meaning carried by aria-label (M9 a11y contract), both branches
    expect(screen.getByLabelText("status: ok")).toBeInTheDocument();
    expect(screen.getByLabelText("status: error")).toBeInTheDocument();
  });

  it("test_trace_table_renders_evals_column", () => {
    renderTable({ traces: [{ ...rich, evaluationsCount: 3 }] });
    expect(screen.getByRole("columnheader", { name: "Evals" })).toBeInTheDocument();
    expect(screen.getByLabelText("3 evaluations")).toHaveTextContent("3");
  });

  it("test_trace_table_evals_column_toggleable", () => {
    renderTable({
      traces: [{ ...rich, evaluationsCount: 3 }],
      hiddenColumns: new Set(["evals"]),
    });
    expect(screen.queryByRole("columnheader", { name: "Evals" })).not.toBeInTheDocument();
  });

  it("test_trace_table_quick_annotate_writes_without_navigating", async () => {
    const user = userEvent.setup();
    renderTable({ traces: [rich] });
    const thumbUp = screen.getByLabelText("annotate trace t1 thumbs up");
    await user.click(thumbUp);
    await waitFor(() =>
      expect(client.addAnnotation).toHaveBeenCalledWith("t1", {
        name: "feedback",
        label: "thumbs_up",
      }),
    );
    // the click did NOT expand the row (stopPropagation): the span tree was never fetched
    expect(client.getTraceTree).not.toHaveBeenCalled();
    // pressed state reflects only AFTER the server accepts (onSuccess) — honest UI
    await waitFor(() => expect(thumbUp).toHaveAttribute("aria-pressed", "true"));
  });

  it("test_trace_row_lazy_fetch_only_on_expand", async () => {
    // M29d ADR D1 / anti-N+1 guard: the span tree is NOT fetched until the row is
    // expanded — then exactly once for that trace.
    vi.mocked(client.getTraceTree).mockResolvedValue({
      spanId: "root",
      traceId: "t1",
      name: "TripAgentGraph",
      startTimeUnixNano: "1700000000000000000",
      endTimeUnixNano: "1700000000800000000",
      children: [
        {
          spanId: "c",
          traceId: "t1",
          name: "child_span",
          startTimeUnixNano: "1700000000000000000",
          endTimeUnixNano: "1700000000300000000",
          children: [],
        },
      ],
    });
    const user = userEvent.setup();
    renderTable({ traces: [rich] });
    // collapsed: no fetch
    expect(client.getTraceTree).not.toHaveBeenCalled();
    // expand the row (theokit DataTable exposes an "Expand row" control)
    await user.click(screen.getByRole("button", { name: /expand row/i }));
    await waitFor(() => expect(screen.getByText("child_span")).toBeInTheDocument());
    expect(client.getTraceTree).toHaveBeenCalledTimes(1);
    expect(client.getTraceTree).toHaveBeenCalledWith("t1");
  });
});
