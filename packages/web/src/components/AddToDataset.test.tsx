import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, violetForge } from "@theokit/ui";
import { AddToDataset } from "./AddToDataset.js";
import * as client from "../api/client.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return { ...actual, getDatasets: vi.fn(), createDataset: vi.fn(), addDatasetItem: vi.fn() };
});

function renderControl() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider defaultTheme="violet-forge" defaultMode="dark" themes={[violetForge]}>
        <AddToDataset traceId="t1" />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(client.addDatasetItem).mockResolvedValue({ id: "d1", name: "travel", createdAt: "x", items: [] });
  vi.mocked(client.createDataset).mockResolvedValue({ id: "d9", name: "new-ds", createdAt: "x", itemCount: 0 });
});

describe("AddToDataset (M26d)", () => {
  it("test_add_to_dataset_creates_new_and_adds", async () => {
    vi.mocked(client.getDatasets).mockResolvedValue({ datasets: [] });
    const user = userEvent.setup();
    renderControl();
    await user.click(screen.getByRole("button", { name: "add trace t1 to a dataset" }));
    await user.type(screen.getByLabelText("new dataset name"), "new-ds");
    await user.click(screen.getByRole("button", { name: "confirm add to dataset" }));
    await waitFor(() => expect(client.createDataset).toHaveBeenCalledWith("new-ds"));
    await waitFor(() => expect(client.addDatasetItem).toHaveBeenCalledWith("d9", "t1"));
  });

  it("test_add_to_dataset_existing", async () => {
    vi.mocked(client.getDatasets).mockResolvedValue({
      datasets: [{ id: "d1", name: "travel", createdAt: "x", itemCount: 0 }],
    });
    const user = userEvent.setup();
    renderControl();
    await user.click(screen.getByRole("button", { name: "add trace t1 to a dataset" }));
    await waitFor(() => expect(screen.getByRole("option", { name: "travel" })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("choose a dataset"), "d1");
    await user.click(screen.getByRole("button", { name: "confirm add to dataset" }));
    await waitFor(() => expect(client.addDatasetItem).toHaveBeenCalledWith("d1", "t1"));
    expect(client.createDataset).not.toHaveBeenCalled();
  });
});
