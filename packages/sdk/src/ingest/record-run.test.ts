import { describe, it, expect, vi } from "vitest";
import { recordRun } from "./theokit.js";
import { LensApiError } from "../read/errors.js";
import type { SDKMessage } from "./sdk-message.js";

const msgs: SDKMessage[] = [{ type: "system", subtype: "init", agent_id: "a", run_id: "r", model: "gpt-4o" }];
const base = { baseUrl: "http://engine.local", apiKey: "theo_live_x", startTimeMs: 1_700_000_000_000 };

describe("recordRun (M115 caller)", () => {
  it("test_recordRun_posts_translated_otlp", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    await recordRun({ messages: msgs }, { ...base, fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://engine.local/v1/traces");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer theo_live_x");
    const body = JSON.parse(init.body as string);
    expect(body.resourceSpans[0].resource.attributes[0].value.stringValue).toBe("theokit-sdk");
  });

  it("test_recordRun_honors_basePath_for_the_edge", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    await recordRun({ messages: msgs }, { ...base, basePath: "/v1/lens", fetch: fetchMock as unknown as typeof fetch });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("http://engine.local/v1/lens/traces");
  });

  it("test_recordRun_throws_typed_error_on_4xx", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: "UNAUTHORIZED", message: "bad key" }), { status: 401 }));
    await expect(recordRun({ messages: msgs }, { ...base, fetch: fetchMock as unknown as typeof fetch })).rejects.toBeInstanceOf(LensApiError);
    await recordRun({ messages: msgs }, { ...base, fetch: fetchMock as unknown as typeof fetch }).catch((e: LensApiError) => {
      expect(e.status).toBe(401);
      expect(e.code).toBe("UNAUTHORIZED");
    });
  });

  it("test_recordRun_maps_network_reject_to_typed_error", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    await recordRun({ messages: msgs }, { ...base, fetch: fetchMock as unknown as typeof fetch }).catch((e: LensApiError) => {
      expect(e).toBeInstanceOf(LensApiError);
      expect(e.status).toBe(0);
      expect(e.code).toBe("NETWORK_ERROR");
    });
  });

  it("test_recordRun_requires_apiKey", async () => {
    await expect(recordRun({ messages: msgs }, { ...base, apiKey: "" })).rejects.toThrow(/apiKey is required/);
  });
});
