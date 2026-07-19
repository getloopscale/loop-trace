import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Loading, ErrorState, EmptyState } from "./States.js";

describe("async-state components", () => {
  it("states_render_loading_error_and_empty", () => {
    const { rerender } = render(<Loading />);
    // role=status + accessible label preserved (sr-only text carries "Loading…")
    expect(screen.getByRole("status")).toHaveTextContent("Loading");

    rerender(<ErrorState message="boom" />);
    expect(screen.getByRole("alert")).toHaveTextContent("boom");

    rerender(<EmptyState message="nothing here" />);
    expect(screen.getByText("nothing here")).toBeInTheDocument();
  });

  it("loading_renders_skeleton_and_drops_legacy_class", () => {
    const { container } = render(<Loading />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    // No legacy light class
    expect(container.querySelector(".state-loading")).toBeNull();
    // Skeleton placeholders present (sr-only label + ≥1 skeleton bar = >1 child)
    const status = container.querySelector("[data-testid='loading']")!;
    expect(status.childElementCount).toBeGreaterThan(1);
  });

  it("empty_state_renders_optional_action_cta", () => {
    render(
      <EmptyState message="No data" action={<button>New trace</button>} />,
    );
    expect(
      screen.getByRole("button", { name: "New trace" }),
    ).toBeInTheDocument();
  });

  it("error_and_empty_drop_legacy_classes", () => {
    const { container, rerender } = render(<ErrorState message="boom" />);
    expect(container.querySelector(".state-error")).toBeNull();
    rerender(<EmptyState message="x" />);
    expect(container.querySelector(".state-empty")).toBeNull();
  });
});
