import { describe, it, expect, vi } from "vitest";
import { recordRun } from "./theokit.js";
import { LensApiError } from "../read/errors.js";
import type { SDKMessage } from "./sdk-message.js";

const msgs: SDKMessage[] = [{ type: "system", subtype: "init", agent_id: "a", run_id: "r", model: "gpt-4o" }];
const base = { baseUrl: "http://engine.local", apiKey: "looptrace_live_x", startTimeMs: 1_700_000_000_000 };

/** A fetch returning queued responses in order (last item repeats if calls exceed the queue). */
function seqFetch(items: Response[]) {
  let i = 0;
  const fn = vi.fn(async () => items[Math.min(i++, items.length - 1)] as Response);
  return fn as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}
const notFound = (status = 404) => new Response(JSON.stringify({ code: "NOT_FOUND", message: "no route" }), { status });

describe("recordRun — native /v1/runs first (M117)", () => {
  it("test_recordRun_posts_native_batch_to_v1_runs", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ partialSuccess: {} }), { status: 200 }));
    await recordRun({ messages: msgs }, { ...base, fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // The native endpoint gets the raw SDKMessage batch — NOT client-side OTLP.
    expect(url).toBe("http://engine.local/v1/runs");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer looptrace_live_x");
    const body = JSON.parse(init.body as string);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages[0].type).toBe("system");
    expect(body.startTimeMs).toBe(1_700_000_000_000);
    // No client-side OTLP envelope on the happy path (the engine maps server-side).
    expect(body.resourceSpans).toBeUndefined();
  });

  it("test_recordRun_honors_basePath_for_the_edge", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ partialSuccess: {} }), { status: 200 }));
    await recordRun({ messages: msgs }, { ...base, basePath: "/v1/lens", fetch: fetchMock as unknown as typeof fetch });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("http://engine.local/v1/lens/runs");
  });

  it("test_recordRun_falls_back_to_traces_on_404", async () => {
    // /v1/runs → 404 (unmounted), /v1/traces → 200. The fallback POSTs OTLP to /v1/traces.
    const fetchMock = seqFetch([notFound(404), new Response(JSON.stringify({ partialSuccess: {} }), { status: 200 })]);
    await recordRun({ messages: msgs }, { ...base, fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [u1] = fetchMock.mock.calls[0] as [string];
    const [u2, init2] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(u1).toBe("http://engine.local/v1/runs");
    expect(u2).toBe("http://engine.local/v1/traces");
    // The fallback body IS the client-side OTLP envelope selected by service.name=theokit-sdk.
    const body2 = JSON.parse(init2.body as string);
    expect(body2.resourceSpans[0].resource.attributes[0].value.stringValue).toBe("theokit-sdk");
  });

  it("test_recordRun_falls_back_on_405", async () => {
    const fetchMock = seqFetch([notFound(405), new Response(JSON.stringify({ partialSuccess: {} }), { status: 200 })]);
    await recordRun({ messages: msgs }, { ...base, fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1] as [string])[0]).toBe("http://engine.local/v1/traces");
  });

  it("test_recordRun_rethrows_on_500 (no fallback)", async () => {
    // A 500 on /v1/runs is NOT the unmounted signal → surface it, never fall back.
    const fetchMock = seqFetch([new Response(JSON.stringify({ code: "INTERNAL", message: "boom" }), { status: 500 })]);
    await expect(recordRun({ messages: msgs }, { ...base, fetch: fetchMock as unknown as typeof fetch })).rejects.toMatchObject({
      status: 500,
      code: "INTERNAL",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no fallback attempt
  });

  it("test_recordRun_maps_a_400_on_runs_to_a_typed_error (no fallback)", async () => {
    const fetchMock = seqFetch([new Response(JSON.stringify({ code: "INVALID_BODY", message: "bad" }), { status: 400 })]);
    await expect(recordRun({ messages: msgs }, { ...base, fetch: fetchMock as unknown as typeof fetch })).rejects.toBeInstanceOf(LensApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("test_recordRun_maps_network_reject_to_typed_error", async () => {
    // A network reject on /v1/runs is NOT the unmounted (404/405) signal → surface it typed, no fallback.
    // `rejects.toMatchObject` (not a `.catch()` that silently no-ops if the SUT ever resolves) is the
    // honest assertion — a regression that swallows the reject fails this test instead of passing green.
    const fetchMock = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    await expect(
      recordRun({ messages: msgs }, { ...base, fetch: fetchMock as unknown as typeof fetch }),
    ).rejects.toMatchObject({ status: 0, code: "NETWORK_ERROR" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no fallback on a network reject
  });

  it("test_recordRun_maps_v1_runs_401_to_a_typed_error (auth failure, not unmounted)", async () => {
    const fetchMock = seqFetch([new Response(JSON.stringify({ code: "UNAUTHORIZED", message: "bad key" }), { status: 401 })]);
    await expect(
      recordRun({ messages: msgs }, { ...base, fetch: fetchMock as unknown as typeof fetch }),
    ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // 401 is not 404/405 → no fallback
  });

  it("test_recordRun_maps_a_late_error_on_the_traces_fallback", async () => {
    // /v1/runs 404 → fallback /v1/traces 401. The fallback's error is surfaced typed (not swallowed).
    const fetchMock = seqFetch([notFound(404), new Response(JSON.stringify({ code: "UNAUTHORIZED", message: "bad key" }), { status: 401 })]);
    await expect(
      recordRun({ messages: msgs }, { ...base, fetch: fetchMock as unknown as typeof fetch }),
    ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    expect(fetchMock).toHaveBeenCalledTimes(2); // ran /v1/runs then the /v1/traces fallback
  });

  it("test_recordRun_maps_the_otlp_body_once_across_both_attempts", async () => {
    // The client-side mapper runs ONLY for the /v1/traces fallback (the /v1/runs happy path maps
    // server-side), and it produces exactly ONE well-formed OTLP envelope — a single deterministic
    // timestamp base, no double-map. The /v1/runs attempt carried the raw batch (no resourceSpans).
    const fetchMock = seqFetch([notFound(404), new Response(JSON.stringify({ partialSuccess: {} }), { status: 200 })]);
    await recordRun({ messages: msgs }, { ...base, fetch: fetchMock as unknown as typeof fetch });
    const runsBody = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(runsBody.resourceSpans).toBeUndefined(); // /v1/runs got the raw batch, not OTLP
    const tracesBody = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(Array.isArray(tracesBody.resourceSpans)).toBe(true);
    expect(tracesBody.resourceSpans).toHaveLength(1); // mapped exactly once → one envelope
  });

  it("test_recordRun_requires_apiKey", async () => {
    await expect(recordRun({ messages: msgs }, { ...base, apiKey: "" })).rejects.toThrow(/apiKey is required/);
  });
});
