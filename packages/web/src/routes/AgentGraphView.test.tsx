import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AgentGraphView } from "./AgentGraphView.js";
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
  name: "Orchestrator",
  startTimeUnixNano: "1700000000000000000",
  endTimeUnixNano: "1700000000500000000",
  children: [
    {
      spanId: "c1",
      traceId: "t1",
      name: "Worker",
      model: "gpt-4o",
      startTimeUnixNano: "1700000000100000000",
      endTimeUnixNano: "1700000000200000000",
      children: [],
    },
  ],
};

function withProviders(ui: React.ReactNode, path = "/") {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(client.listTraces).mockResolvedValue({
    traces: [{ traceId: "t1", name: "Orchestrator" }],
  });
});

describe("AgentGraphView (M21)", () => {
  it("agent_graph_renders_agent_nodes_and_handoffs", async () => {
    vi.mocked(client.getTraceTree).mockResolvedValue(tree);
    const { container } = withProviders(<AgentGraphView />);
    await waitFor(() =>
      expect(container.querySelectorAll("rect").length).toBeGreaterThanOrEqual(2),
    );
    // agent-named nodes + terminals appear in the sr-only summary / labels
    expect(screen.getAllByText(/Orchestrator/).length).toBeGreaterThan(0);
    expect(screen.getByText(/Worker \(1\)/)).toBeInTheDocument();
    // a handoff link renders
    expect(container.querySelectorAll("path").length).toBeGreaterThanOrEqual(1);
  });

  it("agent_graph_view_empty_state", async () => {
    vi.mocked(client.listTraces).mockResolvedValue({ traces: [] });
    withProviders(<AgentGraphView />);
    await waitFor(() =>
      expect(screen.getByText(/No traces yet/i)).toBeInTheDocument(),
    );
  });

  it("agent_routes_render_real_views", async () => {
    // mirrors main.tsx: /agent-graph + /agent-path render the real views (not PlaceholderPage)
    vi.mocked(client.getTraceTree).mockResolvedValue(tree);
    const { unmount } = withProviders(
      <Routes>
        <Route path="/agent-graph" element={<AgentGraphView />} />
        <Route path="/agent-path" element={<AgentPathView />} />
      </Routes>,
      "/agent-graph",
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Agent Graph" })).toBeInTheDocument(),
    );
    // PlaceholderPage's milestone hint is gone
    expect(screen.queryByText(/Coming in M21/i)).toBeNull();
    unmount();
    withProviders(
      <Routes>
        <Route path="/agent-path" element={<AgentPathView />} />
      </Routes>,
      "/agent-path",
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Agent Path" })).toBeInTheDocument(),
    );
  });
});
