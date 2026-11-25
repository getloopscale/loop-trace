import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  RangeProvider,
  useRange,
  rangeToWindow,
  readStoredRange,
} from "./useRange.js";

const FIXED_NOW = Date.parse("2026-06-24T12:00:00.000Z");

describe("rangeToWindow", () => {
  it("test_range_to_window_maps_presets", () => {
    expect(rangeToWindow("24h", FIXED_NOW)).toEqual({
      from: new Date(FIXED_NOW - 86_400_000).toISOString(),
      to: new Date(FIXED_NOW).toISOString(),
    });
    // Δ grows with the preset
    expect(rangeToWindow("1h", FIXED_NOW).from).toBe(
      new Date(FIXED_NOW - 3_600_000).toISOString(),
    );
    expect(rangeToWindow("7d", FIXED_NOW).from).toBe(
      new Date(FIXED_NOW - 7 * 86_400_000).toISOString(),
    );
    expect(rangeToWindow("30d", FIXED_NOW).from).toBe(
      new Date(FIXED_NOW - 30 * 86_400_000).toISOString(),
    );
  });
});

function Probe() {
  const { range, setRange } = useRange();
  return (
    <div>
      <span data-testid="range">{range}</span>
      <button onClick={() => setRange("30d")}>set30</button>
    </div>
  );
}

describe("RangeProvider", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it("test_range_provider_defaults_to_7d", () => {
    render(
      <RangeProvider>
        <Probe />
      </RangeProvider>,
    );
    expect(screen.getByTestId("range").textContent).toBe("7d");
  });

  it("test_range_provider_persists_and_restores", async () => {
    const { unmount } = render(
      <RangeProvider>
        <Probe />
      </RangeProvider>,
    );
    await userEvent.click(screen.getByText("set30"));
    expect(screen.getByTestId("range").textContent).toBe("30d");
    expect(readStoredRange()).toBe("30d");
    unmount();
    // a fresh provider restores the persisted value
    render(
      <RangeProvider>
        <Probe />
      </RangeProvider>,
    );
    expect(screen.getByTestId("range").textContent).toBe("30d");
  });

  it("test_range_provider_corrupt_value_falls_back", () => {
    localStorage.setItem("looptrace.range", "not-a-range");
    expect(readStoredRange()).toBe("7d");
  });

  it("test_range_provider_disabled_storage_falls_back", () => {
    // Negative case (testing.md §4.1): private-mode / disabled storage makes
    // getItem THROW — readStoredRange must swallow it and return the default,
    // never crash boot. Distinct from the corrupt-VALUE case above.
    const spy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new DOMException("storage disabled", "SecurityError");
      });
    try {
      expect(readStoredRange()).toBe("7d");
    } finally {
      spy.mockRestore();
    }
  });
});
