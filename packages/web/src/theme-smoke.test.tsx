import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThemeProvider, violetForge } from "@theokit/ui";

/**
 * T1.1 foundation proof: the Violet Forge theme mounts (exercising @theokit/ui's
 * theme-schema validation — which transitively uses valibot, force-bumped to 1.x
 * to clear GHSA-vqpr-j7v3-hqw9; a broken bump would throw here) AND our own markup
 * carries the design-system token utility classes.
 */
describe("design-system theme foundation", () => {
  it("token_class_resolves_under_theme", () => {
    render(
      <ThemeProvider
        defaultTheme="violet-forge"
        defaultMode="dark"
        themes={[violetForge]}
        defaultDensity="compact"
      >
        <div data-testid="probe" className="bg-card text-display-md">
          probe
        </div>
      </ThemeProvider>,
    );
    const el = screen.getByTestId("probe");
    expect(el).toBeInTheDocument();
    expect(el).toHaveClass("bg-card");
    expect(el).toHaveClass("text-display-md");
  });
});
