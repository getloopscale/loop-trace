import { describe, it, expect, vi, afterEach } from "vitest";
import {
  ApiError,
  getTraceTree,
  listTraces,
  recordReplaySession,
} from "./client.js";

function fetchReturning(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

afterEach(() => vi.restoreAllMocks());

describe("api client", () => {
  it("client_getTraceTree_parses_ok_response_and_throws_on_error", async () => {
    const tree = {
      spanId: "s1",
      traceId: "t1",
      name: "checkout",
      startTimeUnixNano: "1",
      endTimeUnixNano: "2",
      children: [],
    };
    vi.stubGlobal("fetch", fetchReturning(200, tree));
    expect(await getTraceTree("t1")).toMatchObject({ name: "checkout" });

    vi.stubGlobal("fetch", fetchReturning(500, { error: "boom" }));
    await expect(getTraceTree("t1")).rejects.toBeInstanceOf(ApiError);
  });

  it("client_listTraces_returns_parsed_list", async () => {
    vi.stubGlobal("fetch", fetchReturning(200, { traces: [{ traceId: "t1" }] }));
    const { traces } = await listTraces();
    expect(traces).toHaveLength(1);
    expect(traces[0]?.traceId).toBe("t1");
  });

  it("client_404_throws_ApiError_with_status", async () => {
    vi.stubGlobal("fetch", fetchReturning(404, { error: "not found" }));
    await expect(getTraceTree("missing")).rejects.toMatchObject({ status: 404 });
  });

  it("client_propagates_network_rejection_unreachable", async () => {
    // fetch itself rejects (offline / connection refused) — the raw rejection
    // propagates (not an ApiError); the caller's error state handles it.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("fetch failed"))),
    );
    await expect(listTraces()).rejects.toThrow("fetch failed");
  });

  it("test_record_replay_session_is_fail_soft", async () => {
    // M8 D3: the metrics ping must never degrade the replay UX — a rejected POST
    // is swallowed, not thrown.
    const fetchMock = vi.fn(() => Promise.reject(new Error("network down")));
    vi.stubGlobal("fetch", fetchMock);
    expect(() => recordReplaySession("t1")).not.toThrow();
    await Promise.resolve(); // let the swallowed rejection settle
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("test_record_replay_session_posts_trace_id", () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200 } as Response),
    );
    vi.stubGlobal("fetch", fetchMock);
    recordReplaySession("trace-42");
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit?];
    expect(call[1]?.method).toBe("POST");
    expect(String(call[1]?.body)).toContain("trace-42");
  });
});
