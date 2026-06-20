import { describe, it, expect, vi, afterEach } from "vitest";
import { ApiError, getTraceTree, listTraces } from "./client.js";

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
});
