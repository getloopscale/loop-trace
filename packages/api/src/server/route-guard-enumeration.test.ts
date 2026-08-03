import { describe, expect, it } from "vitest";
import type { AuthVerifier, Principal, SpanRepository } from "@usetheo/lens-core";

import { createApp } from "./app.js";
import type { EvaluatorApiDeps } from "./handlers/evaluators.js";
import type { CopilotApiDeps } from "./handlers/copilot.js";
import type { ReplayApiDeps } from "./handlers/replay.js";
import type { ExperimentApiDeps } from "./handlers/experiment.js";

const EXPECTED_DATA_ROUTES = new Set([
  "DELETE /v1/datasets/:datasetId",
  "DELETE /v1/datasets/:datasetId/items/:traceId",
  "DELETE /v1/evaluators/:id",
  "DELETE /v1/guards/:id",
  "DELETE /v1/traces/:traceId/annotations",
  "DELETE /v1/traces/:traceId/ask/feedback",
  "DELETE /v1/traces/:traceId/tags",
  "GET /v1/agents",
  "GET /v1/analytics/cost",
  "GET /v1/analytics/usage-by-user",
  "GET /v1/analytics/tools",
  "GET /v1/analytics/tools/:toolName/traces",
  "GET /v1/datasets",
  "GET /v1/datasets/:datasetId",
  "GET /v1/evaluator-run-jobs/:id",
  "GET /v1/evaluators",
  "GET /v1/evaluators/:id",
  "GET /v1/experiment-runs",
  "GET /v1/experiment-runs/:runId",
  "GET /v1/experiment-runs/compare",
  "GET /v1/guards",
  // M136 — /v1/monitors is canonical; /v1/guards is the deprecated alias, mounted from the SAME
  // table so a route added to one is added to both. Both sets are listed here on purpose: the day
  // the alias is removed, exactly five lines disappear and the count drops by five. That is the
  // deprecation being visible in the test rather than living only in a CHANGELOG note.
  "GET /v1/guards/:id/breach-window",
  "GET /v1/guards/:id/breaches",
  "GET /v1/monitors",
  "GET /v1/monitors/:id/breach-window",
  "GET /v1/monitors/:id/breaches",
  "POST /v1/monitors",
  "DELETE /v1/monitors/:id",
  "GET /v1/labeling-queue",
  "GET /v1/labeling-queue/:itemId",
  "GET /v1/metrics/evaluators",
  "GET /v1/metrics/north-star",
  "GET /v1/metrics/observability",
  "GET /v1/metrics/scores",
  "GET /v1/metrics/span-attributes",
  "GET /v1/sessions",
  "GET /v1/sessions/:sessionId",
  "GET /v1/spans/:spanId",
  "GET /v1/traces",
  "GET /v1/traces/:traceId",
  "GET /v1/traces/:traceId/annotations",
  "GET /v1/traces/:traceId/cost",
  "GET /v1/traces/:traceId/tags",
  "POST /v1/datasets",
  "POST /v1/datasets/:datasetId/items",
  "POST /v1/evaluators",
  "PUT /v1/datasets/:datasetId",
  "PUT /v1/evaluators/:id",
  "POST /v1/evaluators/:id/run",
  "POST /v1/experiment-runs",
  "POST /v1/guards",
  "POST /v1/labeling-queue/:itemId/resolve",
  "POST /v1/labeling-queue/export-as-dataset",
  "POST /v1/replay-sessions",
  "POST /v1/runs",
  "POST /v1/traces",
  "POST /v1/traces/:traceId/annotations",
  "POST /v1/traces/:traceId/ask",
  "POST /v1/traces/:traceId/ask/feedback",
  "POST /v1/traces/:traceId/enqueue-for-labeling",
  "POST /v1/traces/:traceId/replay",
  "POST /v1/traces/:traceId/tags",
]);

function verifier(): AuthVerifier {
  const principal: Principal = {
    workspaceId: "ws-audit",
    userId: "u-audit",
    role: "member",
    scopes: ["observability:read", "observability:write", "observability:delete"],
  };
  return {
    resolvePrincipal: async () => principal,
    verify: async () => true,
  };
}

function buildAuditApp() {
  const repo = new Proxy(
    {},
    {
      get() {
        return async () => ({ traces: [] });
      },
    },
  ) as SpanRepository;

  const evaluatorDeps = {
    repo: new Proxy(
      {},
      {
        get() {
          return async () => null;
        },
      },
    ),
    engine: {
      evaluatorRepo: new Proxy(
        {},
        {
          get() {
            return async () => null;
          },
        },
      ),
      spanRepo: repo,
      judge: null,
      backfillMax: 1,
    },
  } as unknown as EvaluatorApiDeps;

  const copilotDeps = {
    spanRepo: repo,
    chat: null,
    limiter: { tryAcquire: () => true },
  } as unknown as CopilotApiDeps;

  const replayDeps = {
    spanRepo: repo,
    chat: null,
    limiter: { tryAcquire: () => true },
  } as unknown as ReplayApiDeps;

  const experimentDeps = {
    spanRepo: repo,
    evaluatorRepo: { listEvaluators: async () => [] },
    chat: null,
    limiter: { tryAcquire: () => true },
  } as unknown as ExperimentApiDeps;

  return createApp(
    repo,
    undefined,
    { verifier: verifier(), requireCredential: true },
    evaluatorDeps,
    copilotDeps,
    replayDeps,
    experimentDeps,
  );
}

describe("M37 route guard enumeration", () => {
  it("derives the mounted data surface from the live Hono app", () => {
    const app = buildAuditApp();
    const liveRoutes = new Set(
      app.routes
        .filter((route) => route.method !== "ALL")
        // M94 — /health + /ready are intentionally UNAUTHENTICATED probes (no scope guard).
        // M96 — /openapi.json + /v1 + /version are intentionally UNAUTHENTICATED discovery endpoints.
        // Neither is part of the scoped data surface this audit enumerates.
        .filter(
          (route) =>
            !["/v1/healthz", "/v1/healthz/ready", "/openapi.json", "/v1", "/v1/version"].includes(route.path),
        )
        .map((route) => `${route.method} ${route.path}`),
    );
    expect(liveRoutes).toEqual(EXPECTED_DATA_ROUTES);
    expect(liveRoutes.size).toBe(62); // M116: + POST /v1/runs; M133: + GET /v1/evaluator-run-jobs/:id; M135: + GET /v1/guards/:id/breach-window; M136: + 5 canonical /v1/monitors* (the /v1/guards* set stays as the deprecated alias, removed next release → back to 56); M140: + GET /v1/analytics/usage-by-user
  });

  it("asserts every mounted data route carries a per-verb scope middleware", () => {
    const app = buildAuditApp();

    for (const routeKey of EXPECTED_DATA_ROUTES) {
      const [method, path] = routeKey.split(" ");
      const routeEntries = app.routes.filter(
        (route) => route.method === method && route.path === path,
      );
      const handlerSources = routeEntries.map((route) => route.handler.toString());

      expect(routeEntries.length).toBeGreaterThanOrEqual(2);
      expect(
        handlerSources.some((source) => source.includes("INSUFFICIENT_SCOPE")),
        `${routeKey} should mount requireScopeOnPrincipal()`,
      ).toBe(true);
      expect(
        handlerSources.some((source) => !source.includes("INSUFFICIENT_SCOPE")),
        `${routeKey} should also keep its business handler mounted`,
      ).toBe(true);
    }
  });
});
