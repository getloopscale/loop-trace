import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TraceFilters } from "./TraceFilters.js";
import type { ListTracesQuery } from "../api/types.js";

describe("TraceFilters tag filter (M14)", () => {
  it("test_trace_filters_tag_input_updates_query", async () => {
    let query: ListTracesQuery = {};
    const onChange = vi.fn((next: ListTracesQuery) => {
      query = next;
    });
    render(<TraceFilters query={query} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("tag filter"), "prod");
    // debounced (300ms) — wait for the query to carry the tag.
    await waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 1000 });
    await waitFor(() => expect(query.tag).toBe("prod"), { timeout: 1000 });
  });
});

describe("TraceFilters themed toolbar (M-UX)", () => {
  it("trace_filters_themed_controls_keep_all_aria_labels", () => {
    const { container } = render(
      <TraceFilters query={{}} onChange={() => {}} />,
    );
    // every remaining control keeps its accessible name (a11y preserved)
    for (const label of [
      "search content",
      "status filter",
      "model filter",
      "tag filter",
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
    // M29b: time is the global date-range picker — the toolbar no longer has From/To
    expect(screen.queryByLabelText("from time")).toBeNull();
    expect(screen.queryByLabelText("to time")).toBeNull();
    // no legacy wrapper class survives
    expect(container.querySelector(".trace-filters")).toBeNull();
    expect(container.querySelector(".trace-export")).toBeNull();
  });

  it("trace_filters_status_select_updates_query", async () => {
    let query: ListTracesQuery = {};
    const onChange = vi.fn((next: ListTracesQuery) => {
      query = next;
    });
    render(<TraceFilters query={query} onChange={onChange} />);
    await userEvent.selectOptions(
      screen.getByLabelText("status filter"),
      "error",
    );
    expect(query.status).toBe("error");
  });

  it("trace_filters_export_link_keeps_href_and_download", () => {
    render(<TraceFilters query={{ status: "error" }} onChange={() => {}} />);
    const link = screen.getByRole("link", { name: "Export CSV" });
    expect(link).toHaveAttribute("download");
    expect(link.getAttribute("href") ?? "").toContain("status=error");
  });
});

describe("TraceFilters search box (M24)", () => {
  it("list_traces_search_box_filters", async () => {
    let query: ListTracesQuery = {};
    const onChange = vi.fn((next: ListTracesQuery) => {
      query = next;
    });
    render(<TraceFilters query={query} onChange={onChange} />);
    await userEvent.type(screen.getByLabelText("search content"), "lisbon");
    await waitFor(() => expect(query.q).toBe("lisbon"), { timeout: 1000 });
  });

  it("search_box_clear_removes_q", async () => {
    let query: ListTracesQuery = { q: "lisbon" };
    const onChange = vi.fn((next: ListTracesQuery) => {
      query = next;
    });
    render(<TraceFilters query={query} onChange={onChange} />);
    await userEvent.clear(screen.getByLabelText("search content"));
    await waitFor(() => expect(query.q).toBeUndefined(), { timeout: 1000 });
  });
});
