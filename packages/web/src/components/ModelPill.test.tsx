import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ModelPill, modelDotClass } from "./ModelPill.js";

describe("ModelPill (M29)", () => {
  it("test_model_pill_colour_is_stable", () => {
    // same model → same dot colour, always (deterministic hash)
    expect(modelDotClass("gpt-4o")).toBe(modelDotClass("gpt-4o"));
    expect(modelDotClass("claude-sonnet-4")).toBe(modelDotClass("claude-sonnet-4"));
    // the colour is always a token class from the palette
    expect(modelDotClass("gpt-4o")).toMatch(
      /^text-(primary|accent|warning|info|success)$/,
    );
  });

  it("test_model_pill_renders_name", () => {
    render(<ModelPill model="gpt-4o" />);
    expect(screen.getByText("gpt-4o")).toBeInTheDocument();
  });

  it("test_model_pill_empty_is_dash", () => {
    const { container, rerender } = render(<ModelPill model={undefined} />);
    expect(container.textContent).toBe("—");
    rerender(<ModelPill model="" />);
    expect(container.textContent).toBe("—");
  });
});
