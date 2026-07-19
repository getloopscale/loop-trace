import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LiveToggle } from "./LiveToggle.js";
import { AutoRefreshProvider } from "../../hooks/useAutoRefresh.js";

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

function renderToggle() {
  return render(
    <AutoRefreshProvider>
      <LiveToggle />
    </AutoRefreshProvider>,
  );
}

describe("LiveToggle (M31)", () => {
  it("test_live_toggle_off_by_default", () => {
    renderToggle();
    const btn = screen.getByRole("button", { name: /live/i });
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("test_live_toggle_flips_live", async () => {
    renderToggle();
    const btn = screen.getByRole("button", { name: /live/i });
    await userEvent.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "false");
  });

  it("test_live_toggle_shows_pulse_when_on", async () => {
    renderToggle();
    const btn = screen.getByRole("button", { name: /live/i });
    // off: no pulse indicator
    expect(btn.querySelector('[data-testid="live-pulse"]')).toBeNull();
    await userEvent.click(btn);
    // on: a pulsing indicator (decorative — aria-hidden)
    const pulse = btn.querySelector('[data-testid="live-pulse"]');
    expect(pulse).not.toBeNull();
    expect(pulse).toHaveAttribute("aria-hidden", "true");
  });
});
