/**
 * M121 (D3) — span-replay route registration, split out of the history-named
 * `register-extra-routes.ts` into a single-responsibility registrar (SRP). Behavior-preserving move:
 * the surface mounts only when its deps are wired by the composition root; per-verb scope +
 * workspace-from-Principal are unchanged.
 */
import type { Hono } from "hono";

import { requireScopeOnPrincipal } from "../auth/middleware.js";
import { type ReplayApiDeps, replayHandler } from "../handlers/replay.js";
// M118 (D1) — pre-parse bodyLimit 413 cap on the buffering write route.
import { bodyLimit413, REPLAY_MAX_BYTES } from "../body-caps.js";

export function registerReplayRoutes(app: Hono, replay?: ReplayApiDeps): void {
  // M55: span replay — an ephemeral provider call, never a store write (D3); read-augmentation like
  // the copilot ask. The persist path (save-as-dataset) is a separate observability:write route.
  if (replay !== undefined) {
    const rp = replay;
    app.post("/v1/traces/:traceId/replay", bodyLimit413(REPLAY_MAX_BYTES), requireScopeOnPrincipal("observability:read"), (c) => replayHandler(c, rp));
  }
}
