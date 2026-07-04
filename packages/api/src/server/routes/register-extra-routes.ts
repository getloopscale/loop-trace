/**
 * M33 (D5) — route registration for the M36 evaluator/guard surface + the M33 copilot,
 * extracted out of `app.ts` to keep it under the 500-LoC budget (the M36 review's F5).
 * Each surface mounts only when its deps are wired by the composition root; per-verb
 * scope + workspace-from-Principal are unchanged.
 */
import type { Hono } from "hono";

import { requireScopeOnPrincipal } from "../auth/middleware.js";
import {
  type EvaluatorApiDeps,
  createEvaluatorHandler,
  listEvaluatorsHandler,
  getEvaluatorHandler,
  deleteEvaluatorHandler,
  runEvaluatorHandler,
  createGuardHandler,
  listGuardsHandler,
  deleteGuardHandler,
  guardBreachesHandler,
} from "../handlers/evaluators.js";
import { type CopilotApiDeps, askHandler } from "../handlers/copilot.js";
import { type ReplayApiDeps, replayHandler } from "../handlers/replay.js";

export interface ExtraRoutes {
  evaluators?: EvaluatorApiDeps | undefined;
  copilot?: CopilotApiDeps | undefined;
  replay?: ReplayApiDeps | undefined;
}

export function registerExtraRoutes(app: Hono, opts: ExtraRoutes): void {
  // M36: online-evaluators surface. Per-verb scope; workspace from the Principal.
  if (opts.evaluators !== undefined) {
    const ev = opts.evaluators;
    app.post("/v1/evaluators", requireScopeOnPrincipal("observability:write"), (c) => createEvaluatorHandler(c, ev));
    app.get("/v1/evaluators", requireScopeOnPrincipal("observability:read"), (c) => listEvaluatorsHandler(c, ev));
    app.get("/v1/evaluators/:id", requireScopeOnPrincipal("observability:read"), (c) => getEvaluatorHandler(c, ev));
    app.delete("/v1/evaluators/:id", requireScopeOnPrincipal("observability:delete"), (c) => deleteEvaluatorHandler(c, ev));
    app.post("/v1/evaluators/:id/run", requireScopeOnPrincipal("observability:write"), (c) => runEvaluatorHandler(c, ev));
    app.post("/v1/guards", requireScopeOnPrincipal("observability:write"), (c) => createGuardHandler(c, ev));
    app.get("/v1/guards", requireScopeOnPrincipal("observability:read"), (c) => listGuardsHandler(c, ev));
    app.delete("/v1/guards/:id", requireScopeOnPrincipal("observability:delete"), (c) => deleteGuardHandler(c, ev));
    app.get("/v1/guards/:id/breaches", requireScopeOnPrincipal("observability:read"), (c) => guardBreachesHandler(c, ev));
  }

  // M33: "Ask about this step" copilot — read-augmentation (observability:read).
  if (opts.copilot !== undefined) {
    const cp = opts.copilot;
    app.post("/v1/traces/:traceId/ask", requireScopeOnPrincipal("observability:read"), (c) => askHandler(c, cp));
  }

  // M55: span replay — an ephemeral provider call, never a store write (D3); read-augmentation like
  // the copilot ask. The persist path (save-as-dataset) is a separate observability:write route.
  if (opts.replay !== undefined) {
    const rp = opts.replay;
    app.post("/v1/traces/:traceId/replay", requireScopeOnPrincipal("observability:read"), (c) => replayHandler(c, rp));
  }
}
