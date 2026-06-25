import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ThemeProvider, violetForge } from "@theokit/ui";
import { AgentCatalogTable } from "./AgentCatalogTable.js";
import type { Agent } from "../api/types.js";

function agent(over: Partial<Agent> = {}): Agent {
  return {
    name: "research_agent",
    firstSeenAt: "2026-06-20T00:00:00.000Z",
    latestSeenAt: "2026-06-24T00:00:00.000Z",
    runCount: 8,
    versions: ["1.0.0", "1.1.0", "1.2.0"],
    versionCount: 3,
    tools: ["essential_info"],
    systemPrompt: "You are a travel researcher.",
    stale: false,
    highChurn: false,
    anonymous: false,
    ...over,
  };
}

function renderTable(agents: Agent[]) {
  return render(
    <ThemeProvider defaultTheme="violet-forge" defaultMode="dark" themes={[violetForge]}>
      <AgentCatalogTable agents={agents} />
    </ThemeProvider>,
  );
}

describe("AgentCatalogTable (M32)", () => {
  it("test_renders_catalog_row_fields", () => {
    renderTable([agent()]);
    for (const h of ["Agent", "Runs", "Versions", "Tools", "System prompt", "Latest seen", "Health"]) {
      expect(screen.getByRole("columnheader", { name: h })).toBeInTheDocument();
    }
    const dataRow = screen.getAllByRole("row")[1]!;
    expect(within(dataRow).getByText("research_agent")).toBeInTheDocument();
    expect(within(dataRow).getByText("8")).toBeInTheDocument(); // runs
    expect(within(dataRow).getByText("3")).toBeInTheDocument(); // versionCount
    expect(within(dataRow).getByText("essential_info")).toBeInTheDocument();
    expect(within(dataRow).getByText("You are a travel researcher.")).toBeInTheDocument();
  });

  it("test_health_badges_stale_and_churn", () => {
    renderTable([agent({ stale: true, highChurn: true })]);
    expect(screen.getByLabelText("stale")).toBeInTheDocument();
    expect(screen.getByLabelText("high churn")).toBeInTheDocument();
  });

  it("test_healthy_badge_when_no_flags", () => {
    renderTable([agent()]);
    expect(screen.getByLabelText("healthy")).toBeInTheDocument();
  });

  it("test_anonymous_badge_and_unnamed_label", () => {
    renderTable([agent({ name: "", anonymous: true })]);
    expect(screen.getByText("(unnamed)")).toBeInTheDocument();
    expect(screen.getByLabelText("anonymous")).toBeInTheDocument();
  });

  it("test_empty_state", () => {
    renderTable([]);
    expect(screen.getByText(/No agents yet/)).toBeInTheDocument();
  });
});
