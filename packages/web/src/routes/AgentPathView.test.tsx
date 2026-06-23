import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
});
