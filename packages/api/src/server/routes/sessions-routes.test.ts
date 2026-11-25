/**
 * M130 (ISP) — demonstrates the mockability benefit of narrowing the registrar's repo param.
 * `registerSessionsRoutes` now types `repo` as the narrow role `SessionRepository` (2 methods)
 * instead of the 43-method composite `SpanRepository`. This test constructs a mock typed as the
 * ROLE interface — implementing ONLY `listSessions`/`getSessionDetail` — and mounts it. That the
 * mock type-checks (no `as unknown as SpanRepository` cast, no 41 unused stubs) IS the realized ISP
 * win; the assertion proves the wired route still serves the mock end-to-end.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { SessionRepository } from "@looptrace/core";

import { registerSessionsRoutes } from "./sessions-routes.js";

describe("registerSessionsRoutes — ISP role narrowing (M130)", () => {
  it("accepts a mock typed as the narrow SessionRepository role and serves the list route", async () => {
    // The mock implements ONLY the role's two methods. If the registrar still required the composite
    // `SpanRepository`, this object would not type-check without casting away 41 missing methods.
    const repo: SessionRepository = {
      listSessions: async () => ({ sessions: [], total: 0, limit: 0, offset: 0 }),
      getSessionDetail: async () => null,
    };

    const app = new Hono();
    registerSessionsRoutes(app, repo);

    const res = await app.request("/v1/sessions");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [], total: 0, limit: 0, offset: 0 });
  });
});
