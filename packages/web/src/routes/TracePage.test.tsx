import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { TracePage } from "./TracePage.js";
import * as client from "../api/client.js";
import type { TraceTreeNode } from "../api/types.js";

vi.mock("../api/client.js");

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
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

    // tree rendered from the fetched data
    await waitFor(() => expect(screen.getByRole("tree")).toBeInTheDocument());
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

  it("trace_page_shows_error_state_on_api_failure", async () => {
    vi.mocked(client.getTraceTree).mockRejectedValue(new Error("boom"));
    renderAt("/traces/bad");
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Trace not found"),
    );
  });
});
