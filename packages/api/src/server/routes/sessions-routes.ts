/**
 * M121 (D1) — sessions list + detail read routes, extracted verbatim out of `app.ts` to complete the
 * Front-Controller extraction (drop `app.ts` under the 500-LoC budget). Behavior-preserving move:
 * every route keeps its exact path, observability:read scope guard, status codes, and response shape.
 * Mirrors `dataset-routes.ts`: workspace-from-Principal (M22); the repo port is injected by `createApp`.
 */
import type { Hono } from "hono";

import {
  type SessionRepository,
  sessionListResponseSchema,
  sessionDetailResponseSchema,
  apiError,
} from "@usetheo/lens-core";

import { getPrincipal, requireScopeOnPrincipal } from "../auth/middleware.js";

// M130 (ISP) — narrowed from the composite `SpanRepository` to the single role used: sessions.
export function registerSessionsRoutes(app: Hono, repo: SessionRepository): void {
  app.get("/v1/sessions", requireScopeOnPrincipal("observability:read"), async (c) => {
    // M81: server-side pagination — parse the (coerced) limit/offset the BFF forwards; the repo clamps
    // and returns a workspace-scoped total. Invalid/absent params fall back to the repo defaults.
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "", 10);
    const offsetRaw = Number.parseInt(c.req.query("offset") ?? "", 10);
    const list = await repo.listSessions(getPrincipal(c).workspaceId, {
      ...(Number.isFinite(limitRaw) ? { limit: limitRaw } : {}),
      ...(Number.isFinite(offsetRaw) ? { offset: offsetRaw } : {}),
    });
    return c.json(sessionListResponseSchema.parse(list), 200);
  });

  app.get("/v1/sessions/:sessionId", requireScopeOnPrincipal("observability:read"), async (c) => {
    const detail = await repo.getSessionDetail(
      c.req.param("sessionId"),
      getPrincipal(c).workspaceId,
    );
    return detail
      ? c.json(sessionDetailResponseSchema.parse(detail), 200)
      : c.json(apiError("NOT_FOUND", "not found"), 404);
  });
}
