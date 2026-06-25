import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider, violetForge } from "@theokit/ui";
import { AppShell } from "./AppShell.js";

function renderShell(initialPath = "/") {
  return render(
    <ThemeProvider
      defaultTheme="violet-forge"
      defaultMode="dark"
      themes={[violetForge]}
      defaultDensity="compact"
    >
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<div>EXEC BODY</div>} />
            <Route path="/sessions" element={<div>SESSIONS BODY</div>} />
            <Route path="/spans" element={<div>SPANS BODY</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe("AppShell", () => {
  it("app_shell_renders_nav_and_routes_under_theme", async () => {
    const user = userEvent.setup();
    renderShell("/");
    // primary navigation landmark present (a11y)
    expect(
      screen.getByRole("navigation", { name: /primary/i }),
    ).toBeInTheDocument();
    // sidebar nav items + Arize project-view tabs
    expect(screen.getByText("Executions")).toBeInTheDocument();
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByText("Traces")).toBeInTheDocument();
    expect(screen.getByText("Agent Graph")).toBeInTheDocument();
    // routed content renders in the Outlet
    expect(screen.getByText("EXEC BODY")).toBeInTheDocument();
    // sidebar navigation switches routes
    await user.click(screen.getByText("Sessions"));
    expect(screen.getByText("SESSIONS BODY")).toBeInTheDocument();
  });

  it("app_shell_tab_navigates_to_route", async () => {
    const user = userEvent.setup();
    renderShell("/");
    // selecting the Spans project-view tab navigates to /spans
    await user.click(screen.getByRole("tab", { name: "Spans" }));
    expect(screen.getByText("SPANS BODY")).toBeInTheDocument();
  });

  it("app_shell_shows_span_query_toolbar_on_project_tab", () => {
    // M30b: the shared span-query toolbar drives the project-view tabs — it renders on
    // Traces (/), with both the free-text bar and the structured builder.
    renderShell("/");
    expect(screen.getByLabelText("filter spans")).toBeInTheDocument();
    expect(screen.getByLabelText("filter field")).toBeInTheDocument(); // the builder
  });

  it("app_shell_hides_span_query_toolbar_on_sessions", () => {
    // Negative case: a non-project route (activeTab === "") has no toolbar.
    renderShell("/sessions");
    expect(screen.queryByLabelText("filter spans")).toBeNull();
  });

  it("app_shell_marks_active_nav_from_path", () => {
    renderShell("/sessions");
    // active item carries aria-current="page"; a sibling does NOT (negative case)
    const sessions = screen.getByText("Sessions").closest("button");
    const executions = screen.getByText("Executions").closest("button");
    expect(sessions).toHaveAttribute("aria-current", "page");
    expect(executions).not.toHaveAttribute("aria-current", "page");
  });
});
