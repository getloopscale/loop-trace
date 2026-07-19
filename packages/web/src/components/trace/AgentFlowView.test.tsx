import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, violetForge } from "@theokit/ui";
import { AgentFlowView } from "./AgentFlowView.js";
import { SpanQueryProvider } from "../../hooks/useSpanQuery.js";
import type { SankeyModel } from "../../lib/agent-graph.js";
import * as client from "../../api/client.js";

vi.mock("../../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../../api/client.js")>();
  return {
    ...actual,
    listTraces: vi.fn().mockResolvedValue({ traces: [] }),
    getTraceTree: vi.fn(),
  };
});

const build = (): SankeyModel => ({ nodes: [], links: [] });

function renderFlow() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider defaultTheme="violet-forge" defaultMode="dark" themes={[violetForge]}>
      <QueryClientProvider client={qc}>
        <SpanQueryProvider>
          <AgentFlowView title="Agent Graph" ariaLabel="agent graph" build={build} emptyHint="x" />
        </SpanQueryProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.mocked(client.listTraces).mockClear();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe("AgentFlowView (M30b cross-tab)", () => {
  it("test_agent_flow_picker_filtered_by_span_query", async () => {
    // the shared span-query filters which traces the picker offers
    localStorage.setItem("theolens.spanQuery", "kind:llm");
    renderFlow();
    await waitFor(() =>
      expect(client.listTraces).toHaveBeenCalledWith(
        expect.objectContaining({ spanQuery: "kind:llm" }),
      ),
    );
  });

  it("test_agent_flow_no_span_query_lists_all", async () => {
    renderFlow();
    // no span-query → listTraces called with an empty query (all traces)
    await waitFor(() => expect(client.listTraces).toHaveBeenCalledWith({}));
  });
});
