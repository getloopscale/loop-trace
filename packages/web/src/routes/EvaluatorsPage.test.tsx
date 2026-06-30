import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, violetForge } from "@theokit/ui";

import { EvaluatorsPage } from "./EvaluatorsPage.js";
import * as client from "../api/client.js";
import type { EvaluatorRecordDTO } from "../api/types.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return {
    ...actual,
    getEvaluatorDefs: vi.fn(),
    createEvaluatorDef: vi.fn(),
  };
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider defaultTheme="violet-forge" defaultMode="dark" themes={[violetForge]}>
        <EvaluatorsPage />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

const rec: EvaluatorRecordDTO = {
  id: "e1",
  name: "is_error",
  kind: "rule",
  target: "",
  config: { predicate: "status:error" },
  enabled: true,
  createdAt: "2026-06-30T00:00:00.000Z",
};

beforeEach(() => vi.resetAllMocks());

describe("EvaluatorsPage (M36)", () => {
  it("test_evaluators_page_lists", async () => {
    vi.mocked(client.getEvaluatorDefs).mockResolvedValue({ evaluators: [rec] });
    renderPage();
    await waitFor(() => expect(screen.getByText("is_error")).toBeInTheDocument());
  });

  it("test_evaluators_page_creates", async () => {
    vi.mocked(client.getEvaluatorDefs).mockResolvedValue({ evaluators: [] });
    vi.mocked(client.createEvaluatorDef).mockResolvedValue(rec);
    renderPage();
    await waitFor(() => expect(screen.getByText(/No evaluators yet/i)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Evaluator name"), { target: { value: "is_error" } });
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() =>
      expect(client.createEvaluatorDef).toHaveBeenCalledWith(
        expect.objectContaining({ name: "is_error", kind: "rule" }),
      ),
    );
  });
});
