import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider, violetForge } from "@theokit/ui";
import { AppShell } from "../components/AppShell.js";
import { AutoRefreshProvider } from "../hooks/useAutoRefresh.js";
import { TraceListPage } from "./TraceListPage.js";
import * as client from "../api/client.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return { ...actual, listTraces: vi.fn() };
});

function renderApp(path = "/") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider
      defaultTheme="violet-forge"
      defaultMode="dark"
      themes={[violetForge]}
      defaultDensity="compact"
    >
      <QueryClientProvider client={qc}>
        <AutoRefreshProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route element={<AppShell />}>
                <Route path="/" element={<TraceListPage />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </AutoRefreshProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
});

describe("M17 shell integration", () => {
  it("every_route_renders_inside_shell", async () => {
    vi.mocked(client.listTraces).mockResolvedValue({
      traces: [{ traceId: "t1", name: "checkout", durationMs: 5 }],
    });
    renderApp("/");
    // shell chrome present ("Sessions" appears only in the sidebar on the "/" route)
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    // routed body renders inside the shell Outlet
    await waitFor(() =>
      expect(screen.getByText("checkout")).toBeInTheDocument(),
    );
  });

  it("m16_autorefresh_control_preserved_after_rehome", () => {
    vi.mocked(client.listTraces).mockResolvedValue({ traces: [] });
    renderApp("/");
    expect(screen.getByLabelText("Auto-refresh")).toBeInTheDocument();
  });
});
