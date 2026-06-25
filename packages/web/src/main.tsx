import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Navigate, RouterProvider } from "react-router-dom";
import { TraceListPage } from "./routes/TraceListPage.js";
import { TracePage } from "./routes/TracePage.js";
import { AnalyticsPage } from "./routes/AnalyticsPage.js";
import { ToolAnalyticsPage } from "./routes/ToolAnalyticsPage.js";
import { ToolTracesPage } from "./routes/ToolTracesPage.js";
import { DashboardPage } from "./routes/DashboardPage.js";
import { AgentGraphView } from "./routes/AgentGraphView.js";
import { AgentPathView } from "./routes/AgentPathView.js";
import { SessionsListPage } from "./routes/SessionsListPage.js";
import { SessionDetailPage } from "./routes/SessionDetailPage.js";
import { PlaceholderPage } from "./routes/PlaceholderPage.js";
import { AppShell } from "./components/AppShell.js";
import { ThemeProvider, violetForge } from "@theokit/ui";
import { AutoRefreshProvider } from "./hooks/useAutoRefresh.js";
import { RangeProvider } from "./hooks/useRange.js";
import { SpanQueryProvider } from "./hooks/useSpanQuery.js";
import "./styles.css";

const queryClient = new QueryClient();

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: "/", element: <TraceListPage /> },
      { path: "/traces/:traceId", element: <TracePage /> },
      { path: "/analytics", element: <AnalyticsPage /> },
      { path: "/tools", element: <ToolAnalyticsPage /> },
      { path: "/tools/:toolName", element: <ToolTracesPage /> },
      // M20: north-star re-homed into the Pinned-Charts dashboard; /metrics redirects.
      { path: "/metrics", element: <Navigate to="/dashboards" replace /> },
      { path: "/dashboards", element: <DashboardPage /> },
      { path: "/sessions", element: <SessionsListPage /> },
      { path: "/sessions/:sessionId", element: <SessionDetailPage /> },
      {
        path: "/spans",
        element: <PlaceholderPage title="Spans" milestone="M18" />,
      },
      { path: "/agent-graph", element: <AgentGraphView /> },
      { path: "/agent-path", element: <AgentPathView /> },
    ],
  },
]);

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <ThemeProvider
        defaultTheme="violet-forge"
        defaultMode="dark"
        themes={[violetForge]}
        defaultDensity="compact"
        storageKey="theo-lens:theme"
      >
        <QueryClientProvider client={queryClient}>
          <AutoRefreshProvider>
            <RangeProvider>
              <SpanQueryProvider>
                <RouterProvider router={router} />
              </SpanQueryProvider>
            </RangeProvider>
          </AutoRefreshProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}
