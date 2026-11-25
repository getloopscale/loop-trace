import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import * as client from "../api/client.js";
import { useTraceList, useTraceTree } from "./useTraces.js";
import { AutoRefreshProvider } from "./useAutoRefresh.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return { ...actual, listTraces: vi.fn(), getTraceTree: vi.fn() };
});

const KEY = "looptrace.autoRefreshMs";

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <AutoRefreshProvider>{children}</AutoRefreshProvider>
      </QueryClientProvider>
    );
  };
}

describe("useTraces auto-refresh polling", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.mocked(client.listTraces).mockReset();
    vi.mocked(client.getTraceTree).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("auto_refresh_interval_fires_refetch_then_off_fires_none", async () => {
    vi.mocked(client.listTraces).mockResolvedValue({ traces: [] });

    // Part A — 5s interval: at least one extra fetch fires after the interval.
    localStorage.setItem(KEY, "5000");
    const a = renderHook(() => useTraceList(), { wrapper: makeWrapper() });
    await vi.advanceTimersByTimeAsync(0);
    const afterMount = vi.mocked(client.listTraces).mock.calls.length;
    expect(afterMount).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.mocked(client.listTraces).mock.calls.length).toBeGreaterThan(
      afterMount,
    );
    a.unmount();

    // Part B — Off: advancing time fires no poll beyond the mount fetch.
    localStorage.setItem(KEY, JSON.stringify(false));
    vi.mocked(client.listTraces).mockClear();
    renderHook(() => useTraceList(), { wrapper: makeWrapper() });
    await vi.advanceTimersByTimeAsync(0);
    const offMount = vi.mocked(client.listTraces).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(vi.mocked(client.listTraces).mock.calls.length).toBe(offMount);
  });

  it("list_keeps_previous_data_during_refetch_no_flash", async () => {
    // Sub-goal 5: a poll (same-key refetch) must not flash the list to empty —
    // the previous data stays mounted while the next fetch is in flight.
    localStorage.setItem(KEY, "5000");
    let resolveSecond!: (v: { traces: never[] }) => void;
    vi.mocked(client.listTraces)
      .mockResolvedValueOnce({
        traces: [{ traceId: "t1", name: "a", durationMs: 1 }],
      } as never)
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveSecond = r as never;
          }),
      );
    const { result } = renderHook(() => useTraceList(), {
      wrapper: makeWrapper(),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(result.current.data?.traces).toHaveLength(1);

    // The interval fires the second fetch (left pending); the prior rows persist
    // (no flash to empty/undefined while the refetch is in flight).
    await vi.advanceTimersByTimeAsync(5100);
    expect(vi.mocked(client.listTraces).mock.calls.length).toBeGreaterThanOrEqual(
      2,
    );
    expect(result.current.data?.traces).toHaveLength(1);
    resolveSecond({ traces: [] });
  });

  it("trace_tree_does_not_poll", async () => {
    localStorage.setItem(KEY, "5000");
    vi.mocked(client.getTraceTree).mockResolvedValue({
      traceId: "t1",
      root: { spanId: "s1", traceId: "t1", name: "root", children: [] },
    } as never);
    renderHook(() => useTraceTree("t1"), { wrapper: makeWrapper() });
    await vi.advanceTimersByTimeAsync(0);
    const afterMount = vi.mocked(client.getTraceTree).mock.calls.length;
    await vi.advanceTimersByTimeAsync(15000);
    expect(vi.mocked(client.getTraceTree).mock.calls.length).toBe(afterMount);
  });
});
