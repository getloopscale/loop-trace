import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider, violetForge } from "@theokit/ui";
import { AppShell } from "../components/AppShell.js";
import { AutoRefreshProvider } from "../hooks/useAutoRefresh.js";
import { TraceListPage } from "./TraceListPage.js";
import { PlaceholderPage } from "./PlaceholderPage.js";
import * as client from "../api/client.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return { ...actual, listTraces: vi.fn() };
});

const KEY = "theolens.autoRefreshMs";

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
                <Route
                  path="/spans"
                  element={<PlaceholderPage title="Spans" milestone="M18" />}
                />
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
    // data route: shell chrome + routed body
    renderApp("/");
    expect(
      screen.getByRole("navigation", { name: /primary/i }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("checkout")).toBeInTheDocument(),
    );
  });

  it("placeholder_route_renders_inside_shell", () => {
    vi.mocked(client.listTraces).mockResolvedValue({ traces: [] });
    // a second route (the Spans placeholder) also mounts inside the shell
    renderApp("/spans");
    expect(
      screen.getByRole("navigation", { name: /primary/i }),
    ).toBeInTheDocument();
    // the placeholder body heading (distinct from the "Spans" tab trigger)
    expect(
      screen.getByRole("heading", { name: "Spans" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Coming in M18/)).toBeInTheDocument();
  });

  it("m16_autorefresh_control_preserved_and_persists_after_rehome", async () => {
    vi.mocked(client.listTraces).mockResolvedValue({ traces: [] });
    const user = userEvent.setup();
    renderApp("/");
    // present AND still functional: selecting an interval persists (M16 behavior)
    const control = screen.getByLabelText("Auto-refresh");
    expect(control).toBeInTheDocument();
    await user.selectOptions(control, "10s");
    expect(localStorage.getItem(KEY)).toBe("10000");
  });
});
