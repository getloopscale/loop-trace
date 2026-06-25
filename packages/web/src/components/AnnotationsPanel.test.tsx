import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, violetForge } from "@theokit/ui";
import { AnnotationsPanel } from "./AnnotationsPanel.js";
import * as client from "../api/client.js";
import type { AnnotationsResponse } from "../api/types.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return {
    ...actual,
    getAnnotations: vi.fn(),
    addAnnotation: vi.fn(),
    removeAnnotation: vi.fn(),
  };
});

const empty: AnnotationsResponse = { annotations: [] };

function renderPanel(spanId?: string) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider defaultTheme="violet-forge" defaultMode="dark" themes={[violetForge]}>
        <AnnotationsPanel traceId="t1" {...(spanId !== undefined ? { spanId } : {})} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(client.addAnnotation).mockResolvedValue(empty);
  vi.mocked(client.removeAnnotation).mockResolvedValue(empty);
});

describe("AnnotationsPanel (M26b)", () => {
  it("test_annotations_panel_adds_thumbs_and_note", async () => {
    vi.mocked(client.getAnnotations).mockResolvedValue(empty);
    const user = userEvent.setup();
    renderPanel("s1");
    await waitFor(() => expect(screen.getByText("No annotations yet")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "give thumbs up" }));
    await user.type(screen.getByLabelText("annotation note"), "well grounded");
    await user.click(screen.getByRole("button", { name: "Save feedback" }));
    await waitFor(() =>
      expect(client.addAnnotation).toHaveBeenCalledWith("t1", {
        spanId: "s1",
        name: "feedback",
        label: "thumbs_up",
        note: "well grounded",
      }),
    );
  });

  it("test_annotations_panel_lists_existing_scoped_to_span", async () => {
    vi.mocked(client.getAnnotations).mockResolvedValue({
      annotations: [
        { spanId: "s1", name: "feedback", label: "thumbs_down", note: "off topic", annotatorKind: "HUMAN", updatedAt: "x" },
        // a trace-level annotation must NOT show in a span-scoped panel
        { name: "feedback", label: "thumbs_up", annotatorKind: "HUMAN", updatedAt: "x" },
      ],
    });
    renderPanel("s1");
    await waitFor(() => expect(screen.getByText("off topic")).toBeInTheDocument());
    expect(screen.getByLabelText("thumbs down")).toBeInTheDocument();
  });

  it("test_annotations_panel_clear", async () => {
    vi.mocked(client.getAnnotations).mockResolvedValue({
      annotations: [
        { spanId: "s1", name: "feedback", label: "thumbs_up", annotatorKind: "HUMAN", updatedAt: "x" },
      ],
    });
    const user = userEvent.setup();
    renderPanel("s1");
    await waitFor(() => expect(screen.getByLabelText("clear annotation")).toBeInTheDocument());
    await user.click(screen.getByLabelText("clear annotation"));
    await waitFor(() =>
      expect(client.removeAnnotation).toHaveBeenCalledWith("t1", { spanId: "s1", name: "feedback" }),
    );
  });

  it("test_annotations_panel_empty_state", async () => {
    vi.mocked(client.getAnnotations).mockResolvedValue(empty);
    renderPanel("s1");
    await waitFor(() => expect(screen.getByText("No annotations yet")).toBeInTheDocument());
  });

  it("test_annotations_panel_save_disabled_until_input", async () => {
    vi.mocked(client.getAnnotations).mockResolvedValue(empty);
    renderPanel("s1");
    await waitFor(() => expect(screen.getByText("No annotations yet")).toBeInTheDocument());
    // no label, no note → Save is disabled (an empty annotation is rejected)
    expect(screen.getByRole("button", { name: "Save feedback" })).toBeDisabled();
  });
});
