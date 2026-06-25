import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, violetForge } from "@theokit/ui";
import { AgentsListPage } from "./AgentsListPage.js";
import * as client from "../api/client.js";
import type { AgentCatalogResponse } from "../api/types.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return { ...actual, getAgents: vi.fn() };
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider defaultTheme="violet-forge" defaultMode="dark" themes={[violetForge]}>
        <AgentsListPage />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

const catalog: AgentCatalogResponse = {
  agents: [
    {
      name: "research_agent",
      firstSeenAt: "2026-06-20T00:00:00.000Z",
      latestSeenAt: "2026-06-24T00:00:00.000Z",
      runCount: 8,
      versions: ["1.0.0", "1.1.0", "1.2.0"],
      versionCount: 3,
      tools: ["essential_info"],
      systemPrompt: "You are a travel researcher.",
      stale: true,
      highChurn: true,
      anonymous: false,
    },
  ],
};

beforeEach(() => vi.resetAllMocks());

describe("AgentsListPage (M32)", () => {
  it("test_agents_page_renders_catalog_rows", async () => {
    vi.mocked(client.getAgents).mockResolvedValue(catalog);
    renderPage();
    await waitFor(() => expect(screen.getByText("research_agent")).toBeInTheDocument());
    expect(screen.getByText("essential_info")).toBeInTheDocument();
  });

  it("test_agents_page_health_badges", async () => {
    vi.mocked(client.getAgents).mockResolvedValue(catalog);
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("stale")).toBeInTheDocument());
    expect(screen.getByLabelText("high churn")).toBeInTheDocument();
  });

  it("test_agents_page_empty_state", async () => {
    vi.mocked(client.getAgents).mockResolvedValue({ agents: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText(/No agents yet/)).toBeInTheDocument());
  });

  it("test_agents_page_error_state", async () => {
    vi.mocked(client.getAgents).mockRejectedValue(new client.ApiError(500));
    renderPage();
    await waitFor(() => expect(screen.getByText("Failed to load agents")).toBeInTheDocument());
  });
});
