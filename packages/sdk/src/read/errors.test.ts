import { describe, expect, it } from "vitest";

import { LensApiError, errorFromReject, errorFromResponse, invalidBodyError } from "./errors.js";

const res = (status: number, body: string) => new Response(body, { status });

describe("errorFromResponse — envelope mapping (T1.1)", () => {
  it("maps code, message and details[].field from the envelope", async () => {
    const err = await errorFromResponse(
      res(400, JSON.stringify({ code: "INVALID_QUERY", message: "bad range", details: [{ field: "range", issue: "unknown" }] })),
      "GET",
      "/v1/traces",
    );
    expect(err).toBeInstanceOf(LensApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe("INVALID_QUERY");
    expect(err.details?.[0]?.field).toBe("range");
    expect(err.message).toContain("bad range");
  });

  it("uses a synthetic UNEXPECTED_RESPONSE code for a non-JSON body (status kept)", async () => {
    const err = await errorFromResponse(res(502, "<html>bad gateway</html>"), "GET", "/v1/sessions");
    expect(err.status).toBe(502);
    expect(err.code).toBe("UNEXPECTED_RESPONSE");
    expect(err.details).toBeUndefined();
  });

  it("names method, path and status in the message (human + greppable)", async () => {
    const err = await errorFromResponse(res(404, JSON.stringify({ code: "NOT_FOUND", message: "nope" })), "GET", "/v1/spans/s1");
    expect(err.message).toMatch(/GET \/v1\/spans\/s1/);
    expect(err.message).toMatch(/404/);
    expect(err.message).toMatch(/NOT_FOUND/);
  });

  it("drops a malformed details array rather than surfacing junk", async () => {
    const err = await errorFromResponse(res(400, JSON.stringify({ code: "X", message: "m", details: ["nope", { field: 1 }] })), "GET", "/v1/traces");
    expect(err.details).toBeUndefined();
  });
});

describe("errorFromReject — network / timeout (T1.1)", () => {
  it("maps an AbortError to TIMEOUT with status 0", () => {
    const err = errorFromReject(new DOMException("aborted", "AbortError"), "GET", "/v1/traces");
    expect(err.status).toBe(0);
    expect(err.code).toBe("TIMEOUT");
  });

  it("maps any other reject to NETWORK_ERROR with status 0", () => {
    const err = errorFromReject(new TypeError("fetch failed"), "GET", "/v1/traces");
    expect(err.status).toBe(0);
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.message).toContain("fetch failed");
  });
});

describe("invalidBodyError (T1.1)", () => {
  it("is a typed error whose message still names JSON (M103 contract)", () => {
    const err = invalidBodyError(200, "GET", "/v1/analytics/tools");
    expect(err).toBeInstanceOf(LensApiError);
    expect(err.code).toBe("INVALID_RESPONSE_BODY");
    expect(err.message).toMatch(/JSON/i);
  });
});
