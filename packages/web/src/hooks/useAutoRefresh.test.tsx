import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  AutoRefreshProvider,
  useAutoRefresh,
  useAutoRefreshInterval,
  readStored,
  readStoredLive,
  LIVE_MS,
} from "./useAutoRefresh.js";

const KEY = "theolens.autoRefreshMs";
const LIVE_KEY = "theolens.live";

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

  // ---- M31 Live mode ----

  it("test_live_overrides_interval", () => {
    // dropdown Off + Live on → the accessor returns the fast LIVE_MS cadence (D3)
    const { result } = renderHook(
      () => ({ ar: useAutoRefresh(), interval: useAutoRefreshInterval() }),
      { wrapper },
    );
    expect(result.current.interval).toBe(false); // Off, live default off
    act(() => result.current.ar.setLive(true));
    expect(result.current.interval).toBe(LIVE_MS);
  });

  it("test_live_off_reverts_to_interval", () => {
    const { result } = renderHook(
      () => ({ ar: useAutoRefresh(), interval: useAutoRefreshInterval() }),
      { wrapper },
    );
    act(() => result.current.ar.setIntervalMs(30000));
    expect(result.current.interval).toBe(30000);
    act(() => result.current.ar.setLive(true));
    expect(result.current.interval).toBe(LIVE_MS); // live overrides
    act(() => result.current.ar.setLive(false));
    expect(result.current.interval).toBe(30000); // reverts to the chosen interval
  });

  it("test_live_persists_and_restores", () => {
    const first = renderHook(() => useAutoRefresh(), { wrapper });
    act(() => first.result.current.setLive(true));
    expect(localStorage.getItem(LIVE_KEY)).toBe("true");
    expect(readStoredLive()).toBe(true);
    // a fresh provider restores the persisted Live flag
    const second = renderHook(() => useAutoRefresh(), { wrapper });
    expect(second.result.current.live).toBe(true);
  });

  it("test_live_disabled_storage_falls_back_to_off", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    expect(readStoredLive()).toBe(false);
  });

  it("test_live_drives_continuous_refetch", async () => {
    // Live on → a query keyed on useAutoRefreshInterval refetches AGAIN after LIVE_MS
    // (proves "continuous", not just the cadence value). Real timers + waitFor.
    localStorage.setItem(LIVE_KEY, "true");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const queryFn = vi.fn().mockResolvedValue("ok");
    function Combined() {
      const interval = useAutoRefreshInterval();
      useQuery({ queryKey: ["live-probe"], queryFn, refetchInterval: interval });
      return interval;
    }
    renderHook(() => Combined(), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={qc}>
          <AutoRefreshProvider>{children}</AutoRefreshProvider>
        </QueryClientProvider>
      ),
    });
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
    // after one LIVE_MS cadence, react-query refetches again
    await waitFor(() => expect(queryFn.mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: LIVE_MS * 3,
    });
  });
});
