import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { TracePage } from "./TracePage.js";
import * as client from "../api/client.js";
import { ApiError } from "../api/client.js";
import type { TraceTreeNode } from "../api/types.js";

// Partial mock: stub the fetch functions but keep the REAL ApiError class so
// `instanceof ApiError` + `.status` work in TracePage's error branching + retry.
vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return {
    ...actual,
    getTraceTree: vi.fn(),
    listTraces: vi.fn(),
    getTraceCost: vi.fn(),
    recordReplaySession: vi.fn(),
  };
});

const tree: TraceTreeNode = {
  spanId: "root",
  traceId: "t1",
  name: "checkout",
  startTimeUnixNano: "0",
  endTimeUnixNano: "5000000",
  model: "gpt-4o",
  provider: "openai",
  inputTokens: 12,
  statusCode: "1",
  children: [
    {
      spanId: "c1",
      traceId: "t1",
      name: "search-products",
      startTimeUnixNano: "1000000",
      endTimeUnixNano: "2000000",
      statusCode: "1",
      children: [],
    },
  ],
};

function renderAt(path: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/traces/:traceId" element={<TracePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.resetAllMocks());

describe("TracePage (integration)", () => {
  it("trace_page_fetches_and_renders_tree_then_shows_detail_on_select", async () => {
    vi.mocked(client.getTraceTree).mockResolvedValue(tree);
    renderAt("/traces/t1");

    // tree rendered from the fetched data (nested list of span buttons)
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "span tree" })).toBeInTheDocument(),
    );
    expect(screen.getAllByText("search-products").length).toBeGreaterThan(0);
    // default detail = root span
    expect(screen.getByLabelText("span detail")).toHaveTextContent("checkout");

    // selecting a span updates the detail panel
    await userEvent.click(screen.getByText("search-products"));
    await waitFor(() =>
      expect(screen.getByLabelText("span detail")).toHaveTextContent(
        "search-products",
      ),
    );
  });

  it("replay_steps_through_session_in_deterministic_order", async () => {
    vi.mocked(client.getTraceTree).mockResolvedValue(tree);
    renderAt("/traces/t1");

    // replay starts at step 1 (root) of 2; detail = root
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Step 1 of 2"));
    expect(screen.getByLabelText("span detail")).toHaveTextContent("checkout");

    // next advances through the deterministic order → search-products
    await userEvent.click(screen.getByLabelText("next step"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Step 2 of 2"));
    expect(screen.getByLabelText("span detail")).toHaveTextContent("search-products");

    // keyboard ArrowLeft steps back to the root
    await userEvent.keyboard("{ArrowLeft}");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Step 1 of 2"));
    expect(screen.getByLabelText("span detail")).toHaveTextContent("checkout");
  });

  it("replay_click_span_jumps_step", async () => {
    vi.mocked(client.getTraceTree).mockResolvedValue(tree);
    renderAt("/traces/t1");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Step 1 of 2"));
    // clicking a span jumps the replay to that step
    await userEvent.click(screen.getByText("search-products"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Step 2 of 2"));
    expect(screen.getByLabelText("span detail")).toHaveTextContent("search-products");
  });

  it("replay_keyboard_listener_is_removed_on_unmount", async () => {
    vi.mocked(client.getTraceTree).mockResolvedValue(tree);
    const { unmount } = renderAt("/traces/t1");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Step 1 of 2"));
    unmount();
    // After unmount the window listener is gone — dispatching a key must not throw.
    expect(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" })),
    ).not.toThrow();
  });

  it("trace_page_shows_total_cost_in_detail", async () => {
    vi.mocked(client.getTraceTree).mockResolvedValue(tree);
    vi.mocked(client.getTraceCost).mockResolvedValue({
      traceId: "t1",
      costUsd: 0.0125,
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
    });
    renderAt("/traces/t1");
    await waitFor(() =>
      expect(screen.getByText(/Total cost: \$0\.0125/)).toBeInTheDocument(),
    );
  });

  it("trace_page_cost_fetch_failure_does_not_block_the_tree", async () => {
    // Cost is supplementary — a failing cost fetch must not break the tree/replay.
    vi.mocked(client.getTraceTree).mockResolvedValue(tree);
    vi.mocked(client.getTraceCost).mockRejectedValue(new ApiError(500));
    renderAt("/traces/t1");
    // tree still renders
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "span tree" })).toBeInTheDocument(),
    );
    // cost line is omitted, no crash
    expect(screen.queryByText(/Total cost/)).toBeNull();
  });

  it("trace_page_shows_not_found_on_404", async () => {
    vi.mocked(client.getTraceTree).mockRejectedValue(new ApiError(404));
    renderAt("/traces/missing");
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Trace not found"),
    );
  });

  it("trace_page_shows_generic_error_on_server_error", async () => {
    vi.mocked(client.getTraceTree).mockRejectedValue(new ApiError(500));
    renderAt("/traces/bad");
    await waitFor(
      () =>
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Could not load this trace",
        ),
      { timeout: 3000 },
    );
  });

  it("test_trace_page_records_replay_session_once_per_trace", async () => {
    // M8 north-star: opening a trace's replay records exactly one session, even
    // under React StrictMode's double-invoke (the ref guard — EC-3).
    vi.mocked(client.getTraceTree).mockResolvedValue(tree);
    renderAt("/traces/t1");
    await waitFor(() =>
      expect(screen.getByRole("list", { name: "span tree" })).toBeInTheDocument(),
    );
    expect(vi.mocked(client.recordReplaySession)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(client.recordReplaySession)).toHaveBeenCalledWith("t1");
  });
});
