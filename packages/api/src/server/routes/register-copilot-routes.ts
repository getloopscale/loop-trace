/**
 * M121 (D3) — copilot "Ask about this step" route registration, split out of the history-named
 * `register-extra-routes.ts` into a single-responsibility registrar (SRP). Behavior-preserving move:
 * the surface mounts only when its deps are wired by the composition root; per-verb scope +
 * workspace-from-Principal are unchanged.
 */
import type { Hono } from "hono";

import { requireScopeOnPrincipal } from "../auth/middleware.js";
import { type CopilotApiDeps, askHandler, askFeedbackHandler, deleteAskFeedbackHandler } from "../handlers/copilot.js";
// M118 (D1) — pre-parse bodyLimit 413 caps on every buffering write route.
import { bodyLimit413, DEFAULT_ADVANCED_MAX_BYTES } from "../body-caps.js";

export function registerCopilotRoutes(app: Hono, copilot?: CopilotApiDeps): void {
  // M33: "Ask about this step" copilot — read-augmentation (observability:read).
  if (copilot !== undefined) {
    const cp = copilot;
    app.post("/v1/traces/:traceId/ask", bodyLimit413(DEFAULT_ADVANCED_MAX_BYTES), requireScopeOnPrincipal("observability:read"), (c) => askHandler(c, cp));
    // M83: record thumbs feedback on an answer — a WRITE (persists per-tenant), independent of the LLM.
    app.post("/v1/traces/:traceId/ask/feedback", bodyLimit413(DEFAULT_ADVANCED_MAX_BYTES), requireScopeOnPrincipal("observability:write"), (c) => askFeedbackHandler(c, cp));
    app.delete("/v1/traces/:traceId/ask/feedback", requireScopeOnPrincipal("observability:write"), (c) => deleteAskFeedbackHandler(c, cp));
  }
}
