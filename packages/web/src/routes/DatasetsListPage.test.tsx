import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider, violetForge } from "@theokit/ui";
import { DatasetsListPage } from "./DatasetsListPage.js";
import * as client from "../api/client.js";
import type { DatasetsResponse } from "../api/types.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return { ...actual, getDatasets: vi.fn(), createDataset: vi.fn() };
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider defaultTheme="violet-forge" defaultMode="dark" themes={[violetForge]}>
        <MemoryRouter>
          <DatasetsListPage />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(client.createDataset).mockResolvedValue({ id: "d1", name: "travel", createdAt: "x", itemCount: 0 });
});

describe("DatasetsListPage (M26d)", () => {
  it("test_datasets_list_renders_rows_with_counts", async () => {
    const res: DatasetsResponse = {
      datasets: [{ id: "d1", name: "travel", createdAt: "2026-06-25T00:00:00Z", itemCount: 3 }],
    };
    vi.mocked(client.getDatasets).mockResolvedValue(res);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("travel").closest("a")).toHaveAttribute("href", "/datasets/d1"),
    );
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("test_datasets_list_creates", async () => {
    vi.mocked(client.getDatasets).mockResolvedValue({ datasets: [] });
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(screen.getByText(/No datasets yet/)).toBeInTheDocument());
    await user.type(screen.getByLabelText("new dataset name"), "travel");
    await user.click(screen.getByRole("button", { name: "Create dataset" }));
    await waitFor(() => expect(client.createDataset).toHaveBeenCalledWith("travel"));
  });

  it("test_datasets_list_empty_state", async () => {
    vi.mocked(client.getDatasets).mockResolvedValue({ datasets: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText(/No datasets yet/)).toBeInTheDocument());
  });

  it("test_datasets_list_error_state", async () => {
    vi.mocked(client.getDatasets).mockRejectedValue(new client.ApiError(500));
    renderPage();
    await waitFor(() => expect(screen.getByText("Failed to load datasets")).toBeInTheDocument());
  });
});
