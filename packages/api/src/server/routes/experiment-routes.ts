/**
 * M64 — experiment-run routes. Per-verb scope (the CWE-441 second half): `observability:write` for the
 * create-run (a billable provider orchestration), `observability:read` for list/get/compare. The
 * workspace is always the resolved Principal's (never the body). Mirrors `dataset-routes.ts`.
 */
import type { Hono } from "hono";

import { requireScopeOnPrincipal } from "../auth/middleware.js";
import {
  createExperimentRunHandler,
  listExperimentRunsHandler,
  getExperimentRunHandler,
  compareExperimentRunsHandler,
  type ExperimentApiDeps,
} from "../handlers/experiment.js";
import { bodyLimit413, EXPERIMENT_MAX_BYTES } from "../body-caps.js"; // M118 (D1) — pre-parse 413 cap

export function registerExperimentRoutes(app: Hono, deps: ExperimentApiDeps): void {
  app.post("/v1/experiment-runs", bodyLimit413(EXPERIMENT_MAX_BYTES), requireScopeOnPrincipal("observability:write"), (c) => createExperimentRunHandler(c, deps));
  app.get("/v1/experiment-runs", requireScopeOnPrincipal("observability:read"), (c) => listExperimentRunsHandler(c, deps));
  // compare must be registered BEFORE the :runId param route so "/compare" is not captured as a run id.
  app.get("/v1/experiment-runs/compare", requireScopeOnPrincipal("observability:read"), (c) => compareExperimentRunsHandler(c, deps));
  app.get("/v1/experiment-runs/:runId", requireScopeOnPrincipal("observability:read"), (c) => getExperimentRunHandler(c, deps));
}
