import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReplayControls } from "./ReplayControls.js";

describe("ReplayControls", () => {
  it("replay_controls_render_counter_and_disable_at_bounds_and_fire_callbacks", async () => {
    const onPrev = vi.fn();
    const onNext = vi.fn();
    const { rerender } = render(
      <ReplayControls index={0} total={3} onPrev={onPrev} onNext={onNext} />,
    );
    // counter is 1-based
    expect(screen.getByText("Step 1 of 3")).toBeInTheDocument();
    // prev disabled at start; next enabled
    expect(screen.getByLabelText("previous step")).toBeDisabled();
    await userEvent.click(screen.getByLabelText("next step"));
    expect(onNext).toHaveBeenCalledOnce();

    // at the last step: next disabled, prev enabled
    rerender(<ReplayControls index={2} total={3} onPrev={onPrev} onNext={onNext} />);
    expect(screen.getByText("Step 3 of 3")).toBeInTheDocument();
    expect(screen.getByLabelText("next step")).toBeDisabled();
    await userEvent.click(screen.getByLabelText("previous step"));
    expect(onPrev).toHaveBeenCalledOnce();
  });
});
