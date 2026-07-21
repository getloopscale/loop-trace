/**
 * M121 (D3) — evaluator/monitor route registration, split out of the history-named
 * `register-extra-routes.ts` into a single-responsibility registrar (SRP). Behavior-preserving move:
 * the surface mounts only when its deps are wired by the composition root; per-verb scope +
 * workspace-from-Principal are unchanged.
 */
import type { Context, Hono } from "hono";

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
  createMonitorHandler,
  listMonitorsHandler,
  deleteMonitorHandler,
  monitorBreachesHandler,
  monitorBreachWindowHandler,
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
    // M136 — /v1/monitors is canonical. "Guard" promised request-path enforcement theo-lens does
    // not do (and, per the references, should not): GUARDRAIL is a span KIND labelling the inline
    // blocker in the user's own app. A threshold over async verdicts is a Monitor.
    //
    // /v1/guards/* remains mounted as a DEPRECATED ALIAS for one release. The alias points at the
    // SAME handler — never a second implementation, which would drift, and never a 308, which
    // breaks non-redirect-following clients. Removal is scheduled in the release after this one.
    const monitorRoutes: Array<[
      "get" | "post" | "delete",
      string,
      ReturnType<typeof requireScopeOnPrincipal>,
      (c: Context) => Promise<Response>,
    ]> = [
      ["post", "", requireScopeOnPrincipal("observability:write"), (c) => createMonitorHandler(c, ev)],
      ["get", "", requireScopeOnPrincipal("observability:read"), (c) => listMonitorsHandler(c, ev)],
      ["delete", "/:id", requireScopeOnPrincipal("observability:delete"), (c) => deleteMonitorHandler(c, ev)],
      ["get", "/:id/breaches", requireScopeOnPrincipal("observability:read"), (c) => monitorBreachesHandler(c, ev)],
      ["get", "/:id/breach-window", requireScopeOnPrincipal("observability:read"), (c) => monitorBreachWindowHandler(c, ev)],
    ];
    // Both prefixes iterate the SAME table, so a route added to one is added to both by
    // construction. A half-aliased surface is worse than none: a consumer's GET keeps working
    // while its POST starts 404ing, surfacing the break at the worst possible moment.
    for (const prefix of ["/v1/monitors", "/v1/guards"]) {
      for (const [verb, suffix, scope, handler] of monitorRoutes) {
        const path = prefix + suffix;
        if (verb === "post") app.post(path, bodyLimit413(EVALUATOR_MAX_BYTES), scope, handler);
        else if (verb === "get") app.get(path, scope, handler);
        else app.delete(path, scope, handler);
      }
    }
  }
}
