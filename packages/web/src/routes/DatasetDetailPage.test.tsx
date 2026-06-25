import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ThemeProvider, violetForge } from "@theokit/ui";
import { DatasetDetailPage } from "./DatasetDetailPage.js";
import * as client from "../api/client.js";
import type { DatasetDetail } from "../api/types.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return { ...actual, getDataset: vi.fn() };
});

function renderAt(datasetId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider defaultTheme="violet-forge" defaultMode="dark" themes={[violetForge]}>
        <MemoryRouter initialEntries={[`/datasets/${datasetId}`]}>
          <Routes>
            <Route path="/datasets/:datasetId" element={<DatasetDetailPage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.resetAllMocks());

describe("DatasetDetailPage (M26d)", () => {
  it("test_dataset_detail_lists_items_with_snapshot", async () => {
    const detail: DatasetDetail = {
      id: "d1",
      name: "travel",
      createdAt: "x",
      items: [
        { traceId: "t1", inputSnapshot: "plan Rome", outputSnapshot: "Catacombs", createdAt: "x" },
      ],
    };
    vi.mocked(client.getDataset).mockResolvedValue(detail);
    renderAt("d1");
    await waitFor(() => expect(screen.getByRole("heading", { name: "travel" })).toBeInTheDocument());
    expect(screen.getByText("plan Rome")).toBeInTheDocument();
    expect(screen.getByText("Catacombs")).toBeInTheDocument();
    expect(screen.getByText("t1").closest("a")).toHaveAttribute("href", "/traces/t1");
  });

  it("test_dataset_detail_empty_items", async () => {
    vi.mocked(client.getDataset).mockResolvedValue({ id: "d1", name: "empty", createdAt: "x", items: [] });
    renderAt("d1");
    await waitFor(() => expect(screen.getByText(/No items yet/)).toBeInTheDocument());
  });
});
