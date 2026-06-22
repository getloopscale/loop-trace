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
import "./index.css";

const queryClient = new QueryClient();

const router = createBrowserRouter([
  { path: "/", element: <TraceListPage /> },
  { path: "/traces/:traceId", element: <TracePage /> },
  { path: "/analytics", element: <AnalyticsPage /> },
  { path: "/tools", element: <ToolAnalyticsPage /> },
  { path: "/tools/:toolName", element: <ToolTracesPage /> },
  { path: "/metrics", element: <NorthStarPage /> },
  { path: "/dashboards", element: <ObservabilityPage /> },
  { path: "/sessions", element: <SessionsListPage /> },
  { path: "/sessions/:sessionId", element: <SessionDetailPage /> },
]);

const el = document.getElementById("root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );
}
