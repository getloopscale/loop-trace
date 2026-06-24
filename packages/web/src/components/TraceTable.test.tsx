import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider, violetForge } from "@theokit/ui";
import { TraceTable } from "./TraceTable.js";
import type { TraceListItem } from "../api/types.js";

function renderTable(props: Partial<React.ComponentProps<typeof TraceTable>> = {}) {
  return render(
    <ThemeProvider defaultTheme="violet-forge" defaultMode="dark" themes={[violetForge]}>
      <MemoryRouter>
        <TraceTable
          traces={props.traces ?? []}
          sort={props.sort ?? null}
          onSortChange={props.onSortChange ?? (() => {})}
          loading={props.loading ?? false}
        />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

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
});
