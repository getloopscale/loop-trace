import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { AgentPathView } from "./AgentPathView.js";
import * as client from "../api/client.js";
import type { TraceTreeNode } from "../api/types.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return { ...actual, listTraces: vi.fn(), getTraceTree: vi.fn() };
});

const tree: TraceTreeNode = {
  spanId: "root",
  traceId: "t1",
  name: "TripAgent",
  startTimeUnixNano: "1700000000000000000",
  endTimeUnixNano: "1700000000500000000",
  children: [
    {
      spanId: "c1",
      traceId: "t1",
      name: "ChatOpenAI",
      model: "gpt-4o",
      startTimeUnixNano: "1700000000100000000",
      endTimeUnixNano: "1700000000200000000",
      children: [],
    },
  ],
};

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AgentPathView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.resetAllMocks());

describe("AgentPathView (M21)", () => {
  it("agent_path_sankey_renders_kind_flow_from_trace_tree", async () => {
    vi.mocked(client.listTraces).mockResolvedValue({
      traces: [{ traceId: "t1", name: "TripAgent" }],
    });
    vi.mocked(client.getTraceTree).mockResolvedValue(tree);
    const { container } = renderPage();
    // the Sankey renders (rects) once the tree loads
    await waitFor(() =>
      expect(container.querySelectorAll("rect").length).toBeGreaterThanOrEqual(3),
    );
    // kind legend present (chain root + llm child)
    expect(screen.getByRole("list", { name: "kind legend" })).toBeInTheDocument();
    // sr-only summary mentions the kinds
    expect(screen.getByText(/chain \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/llm \(1\)/)).toBeInTheDocument();
  });

  it("agent_path_empty_when_no_traces", async () => {
    vi.mocked(client.listTraces).mockResolvedValue({ traces: [] });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/No traces yet/i)).toBeInTheDocument(),
    );
  });

  it("agent_view_shows_error_when_tree_fetch_fails", async () => {
    // Failure scenario (plan): the trace list loads but the selected tree fetch
    // rejects → fail-soft ErrorState, no crash.
    vi.mocked(client.listTraces).mockResolvedValue({
      traces: [{ traceId: "t1", name: "TripAgent" }],
    });
    vi.mocked(client.getTraceTree).mockRejectedValue(new client.ApiError(500));
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByText(/Failed to load the selected trace/i),
      ).toBeInTheDocument(),
    );
  });

  it("agent_path_rerenders_on_trace_change", async () => {
    // EC-6: selecting a different trace re-derives + re-renders (not pinned to the first).
    vi.mocked(client.listTraces).mockResolvedValue({
      traces: [
        { traceId: "t1", name: "first" },
        { traceId: "t2", name: "second" },
      ],
    });
    const toolTree: TraceTreeNode = {
      ...tree,
      traceId: "t2",
      name: "SecondRoot",
      children: [
        {
          spanId: "x",
          traceId: "t2",
          name: "Searcher",
          startTimeUnixNano: "1700000000100000000",
          endTimeUnixNano: "1700000000200000000",
          attributes: { "gen_ai.tool.name": "web" },
          children: [],
        },
      ],
    };
    vi.mocked(client.getTraceTree).mockImplementation((id: string) =>
      Promise.resolve(id === "t2" ? toolTree : tree),
    );
    renderPage();
    // default = first trace (t1) → its kinds (chain + llm)
    await waitFor(() => expect(screen.getByText(/llm \(1\)/)).toBeInTheDocument());
    // switch to t2 → its kinds change (a tool appears)
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "select trace" }),
      "t2",
    );
    await waitFor(() => expect(screen.getByText(/tool \(1\)/)).toBeInTheDocument());
  });
});
