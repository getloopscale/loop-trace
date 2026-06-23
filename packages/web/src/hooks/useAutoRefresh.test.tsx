import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  AutoRefreshProvider,
  useAutoRefresh,
  useAutoRefreshInterval,
  readStored,
} from "./useAutoRefresh.js";

const KEY = "theolens.autoRefreshMs";

function wrapper({ children }: { children: ReactNode }) {
  return <AutoRefreshProvider>{children}</AutoRefreshProvider>;
}

describe("useAutoRefresh", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("test_useAutoRefreshInterval_defaults_to_off_without_provider", () => {
    const { result } = renderHook(() => useAutoRefreshInterval());
    expect(result.current).toBe(false);
  });

  it("test_provider_defaults_to_off_when_storage_empty", () => {
    const { result } = renderHook(() => useAutoRefreshInterval(), { wrapper });
    expect(result.current).toBe(false);
  });

  it("test_set_interval_persists_and_round_trips", () => {
    const { result } = renderHook(() => useAutoRefresh(), { wrapper });
    act(() => result.current.setIntervalMs(10000));
    expect(result.current.intervalMs).toBe(10000);
    expect(localStorage.getItem(KEY)).toBe("10000");
  });

  it("test_invalid_stored_value_falls_back_to_off", () => {
    localStorage.setItem(KEY, "1234");
    expect(readStored()).toBe(false);
  });

  it("test_localStorage_unavailable_falls_back_to_off", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    expect(readStored()).toBe(false);
    const { result } = renderHook(() => useAutoRefresh(), { wrapper });
    expect(() => act(() => result.current.setIntervalMs(10000))).not.toThrow();
    // in-memory state still updates even when persistence fails
    expect(result.current.intervalMs).toBe(10000);
  });
});
