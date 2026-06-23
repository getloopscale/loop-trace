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
    // sidebar nav present
    expect(screen.getByText("Executions")).toBeInTheDocument();
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    // Arize project-view tabs present
    expect(screen.getByText("Traces")).toBeInTheDocument();
    expect(screen.getByText("Agent Graph")).toBeInTheDocument();
    // routed content renders in the Outlet
    expect(screen.getByText("EXEC BODY")).toBeInTheDocument();
    // clicking a sidebar item navigates
    await user.click(screen.getByText("Sessions"));
    expect(screen.getByText("SESSIONS BODY")).toBeInTheDocument();
  });

  it("app_shell_marks_active_nav_from_path", () => {
    renderShell("/sessions");
    // the Sessions sidebar item is active (aria-current or active styling) at /sessions
    const sessions = screen.getByText("Sessions").closest("button, a");
    expect(sessions).toBeTruthy();
    // active item carries the primary text token (bg-primary/10 text-primary per theo-ui)
    expect(sessions?.className ?? "").toMatch(/primary|active/i);
  });
});
