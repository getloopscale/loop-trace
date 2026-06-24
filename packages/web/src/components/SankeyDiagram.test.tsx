import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SankeyDiagram } from "./SankeyDiagram.js";
import type { SankeyModel } from "../lib/agent-graph.js";

const model: SankeyModel = {
  nodes: [
    { id: "Start", kind: "terminal", count: 1 },
    { id: "chain", kind: "chain", count: 1 },
    { id: "llm", kind: "llm", count: 2 },
    { id: "End", kind: "terminal", count: 2 },
  ],
  links: [
    { source: "Start", target: "chain", value: 1 },
    { source: "chain", target: "llm", value: 2 },
    { source: "llm", target: "End", value: 2 },
  ],
};

describe("SankeyDiagram (M21)", () => {
  it("sankey_diagram_renders_nodes_and_links", () => {
    const { container } = render(
      <SankeyDiagram model={model} ariaLabel="agent path" />,
    );
    // node rects (≥ the 4 nodes) + link paths (≥ the 3 links)
    expect(container.querySelectorAll("rect").length).toBeGreaterThanOrEqual(4);
    expect(container.querySelectorAll("path").length).toBeGreaterThanOrEqual(3);
    // sr-only summary lists the non-terminal nodes with counts
    expect(screen.getByText(/chain \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/llm \(2\)/)).toBeInTheDocument();
    // no NaN in the laid-out geometry
    expect(container.innerHTML).not.toMatch(/NaN/);
  });

  it("sankey_diagram_single_flow_no_nan", () => {
    // MEDIUM-1: the degenerate Start→node→End shape (a single-span trace's model)
    // must render without NaN geometry.
    const single = {
      nodes: [
        { id: "Start", kind: "terminal" as const, count: 1 },
        { id: "unknown", kind: "unknown" as const, count: 1 },
        { id: "End", kind: "terminal" as const, count: 1 },
      ],
      links: [
        { source: "Start", target: "unknown", value: 1 },
        { source: "unknown", target: "End", value: 1 },
      ],
    };
    const { container } = render(
      <SankeyDiagram model={single} ariaLabel="single" />,
    );
    expect(container.querySelectorAll("rect").length).toBeGreaterThanOrEqual(3);
    expect(container.innerHTML).not.toMatch(/NaN/);
  });

  it("sankey_diagram_empty_model_no_nan", () => {
    const { container } = render(
      <SankeyDiagram model={{ nodes: [], links: [] }} ariaLabel="empty" />,
    );
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("rect")).toBeNull();
    expect(container.innerHTML).not.toMatch(/NaN/);
    expect(screen.getByText("no spans")).toBeInTheDocument();
  });
});
