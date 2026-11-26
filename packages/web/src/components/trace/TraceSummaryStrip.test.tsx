import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TraceSummaryStrip } from "./TraceSummaryStrip.js";
import * as client from "../../api/client.js";

vi.mock("../../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../../api/client.js")>();
  return { ...actual, getObservability: vi.fn() };
});

function renderStrip() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <>
      <QueryClientProvider client={qc}>
        <TraceSummaryStrip />
      </QueryClientProvider>
    </>,
  );
}

beforeEach(() => vi.resetAllMocks());

describe("TraceSummaryStrip", () => {
  it("summary_strip_renders_stat_tiles_from_observability", async () => {
    vi.mocked(client.getObservability).mockResolvedValue({
      range: "24h",
      traffic: [
        { periodStart: "p1", traceCount: 5, errorCount: 0, errorRate: 0 },
        { periodStart: "p2", traceCount: 7, errorCount: 1, errorRate: 0.14 },
      ],
      latency: [
        { periodStart: "p1", p50Ms: 100, p75Ms: 150, p95Ms: 200, p99Ms: 300 },
        { periodStart: "p2", p50Ms: 120, p75Ms: 180, p95Ms: 240, p99Ms: 360 },
      ],
      tokensByModel: [
        { periodStart: "p1", model: "gpt-4o", totalTokens: 100, costUsd: 0.01 },
        { periodStart: "p2", model: "gpt-4o", totalTokens: 200, costUsd: 0.02 },
      ],
    });
    renderStrip();
    // tiles render the aggregates: 12 traces, 300 tokens, $0.03 cost
    await waitFor(() => expect(screen.getByText("12")).toBeInTheDocument());
    // Label reflects the global range (default "7d" when no RangeProvider — M29b).
    expect(screen.getByText("Traces (7d)")).toBeInTheDocument();
    expect(screen.getByText("300")).toBeInTheDocument();
    expect(screen.getByText("$0.03")).toBeInTheDocument();
    expect(screen.getByText("Latency p95")).toBeInTheDocument();
  });

  it("summary_strip_renders_zeros_when_no_data", async () => {
    vi.mocked(client.getObservability).mockResolvedValue({
      range: "24h",
      traffic: [],
      latency: [],
      tokensByModel: [],
    });
    renderStrip();
    // no crash; the labels render even with empty series
    await waitFor(() =>
      expect(screen.getByText("Traces (7d)")).toBeInTheDocument(),
    );
  });
});
