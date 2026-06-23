import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TraceTags } from "./TraceTags.js";
import * as client from "../api/client.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return {
    ...actual,
    getTraceTags: vi.fn(),
    addTraceTag: vi.fn(),
    removeTraceTag: vi.fn(),
  };
});

function renderTags() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <TraceTags traceId="t1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.resetAllMocks());

describe("TraceTags (M14)", () => {
  it("test_trace_tags_renders_and_adds", async () => {
    vi.mocked(client.getTraceTags).mockResolvedValue({ tags: ["prod"] });
    vi.mocked(client.addTraceTag).mockResolvedValue({ tags: ["prod", "urgent"] });
    renderTags();
    await waitFor(() => expect(screen.getByText("prod")).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText("add tag"), "urgent");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(client.addTraceTag).toHaveBeenCalledWith("t1", "urgent");
    await waitFor(() => expect(screen.getByText("urgent")).toBeInTheDocument());
  });

  it("test_trace_tags_removes", async () => {
    vi.mocked(client.getTraceTags).mockResolvedValue({ tags: ["prod"] });
    vi.mocked(client.removeTraceTag).mockResolvedValue({ tags: [] });
    renderTags();
    await waitFor(() => expect(screen.getByText("prod")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "remove tag prod" }));
    expect(client.removeTraceTag).toHaveBeenCalledWith("t1", "prod");
  });

  it("test_trace_tags_empty_and_error_states", async () => {
    vi.mocked(client.getTraceTags).mockResolvedValue({ tags: [] });
    const { unmount } = renderTags();
    await waitFor(() => expect(screen.getByText("No tags yet")).toBeInTheDocument());
    unmount();
    vi.mocked(client.getTraceTags).mockRejectedValue(new client.ApiError(500));
    renderTags();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Failed to load tags"),
    );
  });
});
