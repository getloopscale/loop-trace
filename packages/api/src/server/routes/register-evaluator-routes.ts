/**
 * M121 (D3) — evaluator/guard route registration, split out of the history-named
 * `register-extra-routes.ts` into a single-responsibility registrar (SRP). Behavior-preserving move:
 * the surface mounts only when its deps are wired by the composition root; per-verb scope +
 * workspace-from-Principal are unchanged.
 */
import type { Hono } from "hono";

import { requireScopeOnPrincipal } from "../auth/middleware.js";
import {
  type EvaluatorApiDeps,
  createEvaluatorHandler,
  listEvaluatorsHandler,
  getEvaluatorHandler,
  updateEvaluatorHandler,
  deleteEvaluatorHandler,
  runEvaluatorHandler,
  getEvaluatorRunJobHandler,
  createGuardHandler,
  listGuardsHandler,
  deleteGuardHandler,
  guardBreachesHandler,
} from "../handlers/evaluators.js";
// M118 (D1) — pre-parse bodyLimit 413 caps on every buffering write route (reuse each route's cap).
import { bodyLimit413, EVALUATOR_MAX_BYTES } from "../body-caps.js";

export function registerEvaluatorRoutes(app: Hono, evaluators?: EvaluatorApiDeps): void {
  // M36: online-evaluators surface. Per-verb scope; workspace from the Principal.
  if (evaluators !== undefined) {
    const ev = evaluators;
    app.post("/v1/evaluators", bodyLimit413(EVALUATOR_MAX_BYTES), requireScopeOnPrincipal("observability:write"), (c) => createEvaluatorHandler(c, ev));
    app.get("/v1/evaluators", requireScopeOnPrincipal("observability:read"), (c) => listEvaluatorsHandler(c, ev));
    app.get("/v1/evaluators/:id", requireScopeOnPrincipal("observability:read"), (c) => getEvaluatorHandler(c, ev));
    app.put("/v1/evaluators/:id", bodyLimit413(EVALUATOR_MAX_BYTES), requireScopeOnPrincipal("observability:write"), (c) => updateEvaluatorHandler(c, ev));
    app.delete("/v1/evaluators/:id", requireScopeOnPrincipal("observability:delete"), (c) => deleteEvaluatorHandler(c, ev));
    app.post("/v1/evaluators/:id/run", bodyLimit413(EVALUATOR_MAX_BYTES), requireScopeOnPrincipal("observability:write"), (c) => runEvaluatorHandler(c, ev));
    // M133 — poll an async evaluator-run job's status/progress (read scope; the run itself is write).
    app.get("/v1/evaluator-run-jobs/:id", requireScopeOnPrincipal("observability:read"), (c) => getEvaluatorRunJobHandler(c, ev));
    app.post("/v1/guards", bodyLimit413(EVALUATOR_MAX_BYTES), requireScopeOnPrincipal("observability:write"), (c) => createGuardHandler(c, ev));
    app.get("/v1/guards", requireScopeOnPrincipal("observability:read"), (c) => listGuardsHandler(c, ev));
    app.delete("/v1/guards/:id", requireScopeOnPrincipal("observability:delete"), (c) => deleteGuardHandler(c, ev));
    app.get("/v1/guards/:id/breaches", requireScopeOnPrincipal("observability:read"), (c) => guardBreachesHandler(c, ev));
  }
}
