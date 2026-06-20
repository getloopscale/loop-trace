import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { TraceListPage } from "./routes/TraceListPage.js";
import { TracePage } from "./routes/TracePage.js";
import "./index.css";

const queryClient = new QueryClient();

const router = createBrowserRouter([
  { path: "/", element: <TraceListPage /> },
  { path: "/traces/:traceId", element: <TracePage /> },
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
