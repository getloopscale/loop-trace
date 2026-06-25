import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { EvalsPage } from "./EvalsPage.js";
import { RangeProvider } from "../hooks/useRange.js";
import * as client from "../api/client.js";
import type { EvaluatorsResponse } from "../api/types.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return { ...actual, getEvaluators: vi.fn() };
});

const evals: EvaluatorsResponse = {
  evaluators: [
    { name: "hallucination", count: 3, avgScore: 0.3, labels: { factual: 2, hallucinated: 1 } },
    { name: "relevance", count: 1, labels: { relevant: 1 } },
  ],
};

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <RangeProvider>
        <MemoryRouter>
          <EvalsPage />
        </MemoryRouter>
      </RangeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe("EvalsPage (M26 Online Evaluators)", () => {
  it("evals_page_renders_a_card_per_evaluator_with_avg_and_labels", async () => {
    vi.mocked(client.getEvaluators).mockResolvedValue(evals);
    renderPage();
    await waitFor(() =>
      expect(screen.getByLabelText("hallucination")).toBeInTheDocument(),
    );
    // avg score formatted to 2 decimals
    expect(screen.getByText("0.30")).toBeInTheDocument();
    // label distribution rows
    expect(screen.getByText("factual")).toBeInTheDocument();
    expect(screen.getByText("hallucinated")).toBeInTheDocument();
    // second evaluator with no numeric score → "—"
    expect(screen.getByLabelText("relevance")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("evals_page_queries_with_the_current_range", async () => {
    vi.mocked(client.getEvaluators).mockResolvedValue(evals);
    renderPage();
    await waitFor(() =>
      expect(client.getEvaluators).toHaveBeenCalledWith("7d"), // RangeProvider default
    );
  });

  it("evals_page_shows_empty_state_when_no_evaluators", async () => {
    vi.mocked(client.getEvaluators).mockResolvedValue({ evaluators: [] });
    renderPage();
    await waitFor(() =>
      expect(screen.getByText(/No online evaluations in range/)).toBeInTheDocument(),
    );
  });

  it("evals_page_shows_error_state_on_failure", async () => {
    vi.mocked(client.getEvaluators).mockRejectedValue(new client.ApiError(500));
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("Failed to load evaluators")).toBeInTheDocument(),
    );
  });
});
