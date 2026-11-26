import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TraceRowSpanTree } from "./TraceRowSpanTree.js";
import type { TraceTreeNode } from "../../api/types.js";
import * as client from "../../api/client.js";

vi.mock("../../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../../api/client.js")>();
  return { ...actual, getTraceTree: vi.fn() };
});

function renderTree(traceId = "t1") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <>
      <QueryClientProvider client={qc}>
        <TraceRowSpanTree traceId={traceId} />
      </QueryClientProvider>
    </>,
  );
}

// root → local_agent (chain, has children) → VectorStoreRetriever (retriever) + ChatOpenAI (llm)
const tree: TraceTreeNode = {
  spanId: "root",
  traceId: "t1",
  name: "TripAgentGraph",
  startTimeUnixNano: "1700000000000000000",
  endTimeUnixNano: "1700000005000000000",
  children: [
    {
      spanId: "a",
      traceId: "t1",
      name: "local_agent",
      startTimeUnixNano: "1700000000000000000",
      endTimeUnixNano: "1700000000800000000",
      children: [
        {
          spanId: "r",
          traceId: "t1",
          name: "VectorStoreRetriever",
          startTimeUnixNano: "1700000000000000000",
          endTimeUnixNano: "1700000000250000000",
          attributes: { "gen_ai.operation.name": "retrieve" },
          children: [],
        },
        {
          spanId: "l",
          traceId: "t1",
          name: "ChatOpenAI",
          model: "gpt-4o",
          startTimeUnixNano: "1700000000000000000",
          endTimeUnixNano: "1700000000450000000",
          inputTokens: 300,
          outputTokens: 60,
          children: [],
        },
      ],
    },
  ],
};

beforeEach(() => vi.resetAllMocks());

describe("TraceRowSpanTree (M29d)", () => {
  it("test_trace_row_span_tree_renders_kind_badges_latency_tokens", async () => {
    vi.mocked(client.getTraceTree).mockResolvedValue(tree);
    renderTree();
    // child span names render (root itself is the row, not repeated here)
    await waitFor(() =>
      expect(screen.getByText("local_agent")).toBeInTheDocument(),
    );
    expect(screen.getByText("VectorStoreRetriever")).toBeInTheDocument();
    expect(screen.getByText("ChatOpenAI")).toBeInTheDocument();
    // kind labels (canonical taxonomy: agent→chain, retriever, llm)
    expect(screen.getByText("chain")).toBeInTheDocument();
    expect(screen.getByText("retriever")).toBeInTheDocument();
    expect(screen.getByText("llm")).toBeInTheDocument();
    // per-span latency + tokens (the LLM span: 450ms, 360 tk)
    expect(screen.getByText("450 ms")).toBeInTheDocument();
    expect(screen.getByText(/360\s*tk/)).toBeInTheDocument();
    // fetched exactly once for this trace
    expect(client.getTraceTree).toHaveBeenCalledTimes(1);
    expect(client.getTraceTree).toHaveBeenCalledWith("t1");
  });

  it("test_trace_row_span_tree_handles_error", async () => {
    // 404 (trace not found) — deterministic 4xx is not retried (useTraces retry policy)
    vi.mocked(client.getTraceTree).mockRejectedValue(new client.ApiError(404));
    renderTree();
    await waitFor(() =>
      expect(screen.getByText(/failed to load spans/i)).toBeInTheDocument(),
    );
  });

  it("test_trace_row_span_tree_handles_no_children", async () => {
    vi.mocked(client.getTraceTree).mockResolvedValue({
      spanId: "solo",
      traceId: "t1",
      name: "solo",
      startTimeUnixNano: "1700000000000000000",
      endTimeUnixNano: "1700000000100000000",
      children: [],
    });
    renderTree();
    await waitFor(() =>
      expect(screen.getByText(/no child spans/i)).toBeInTheDocument(),
    );
  });
});
