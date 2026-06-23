import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { TraceListPage } from "./routes/TraceListPage.js";
import { TracePage } from "./routes/TracePage.js";
import { AnalyticsPage } from "./routes/AnalyticsPage.js";
import { ToolAnalyticsPage } from "./routes/ToolAnalyticsPage.js";
import { ToolTracesPage } from "./routes/ToolTracesPage.js";
import { NorthStarPage } from "./routes/NorthStarPage.js";
import { ObservabilityPage } from "./routes/ObservabilityPage.js";
import { SessionsListPage } from "./routes/SessionsListPage.js";
import { SessionDetailPage } from "./routes/SessionDetailPage.js";
import { PlaceholderPage } from "./routes/PlaceholderPage.js";
import { AppShell } from "./components/AppShell.js";
import { ThemeProvider, violetForge } from "@theokit/ui";
import { AutoRefreshProvider } from "./hooks/useAutoRefresh.js";
import "./styles.css";
import "./legacy.css";

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
      { path: "/metrics", element: <NorthStarPage /> },
      { path: "/dashboards", element: <ObservabilityPage /> },
      { path: "/sessions", element: <SessionsListPage /> },
      { path: "/sessions/:sessionId", element: <SessionDetailPage /> },
      {
        path: "/spans",
        element: <PlaceholderPage title="Spans" milestone="M18" />,
      },
      {
        path: "/agent-graph",
        element: <PlaceholderPage title="Agent Graph" milestone="M21" />,
      },
      {
        path: "/agent-path",
        element: <PlaceholderPage title="Agent Path" milestone="M21" />,
      },
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
            <RouterProvider router={router} />
          </AutoRefreshProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}
