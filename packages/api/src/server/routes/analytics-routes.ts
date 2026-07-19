/**
 * M121 (D1) — agents catalog + analytics (tools / tool-drilldown / cost) read routes, extracted
 * verbatim out of `app.ts` to complete the Front-Controller extraction. Behavior-preserving move:
 * every route keeps its exact path, per-verb scope guard, status codes, and response shape. Mirrors
 * `dataset-routes.ts`: workspace-from-Principal (M22); the repo port is injected by `createApp`.
 */
import type { Hono } from "hono";

import {
  type TraceReadRepository,
  type AggregateRepository,
  agentCatalogResponseSchema,
  toolStatsResponseSchema,
  traceListResponseSchema,
  costByPeriodResponseSchema,
  apiError,
} from "@usetheo/lens-core";

import { getPrincipal, requireScopeOnPrincipal } from "../auth/middleware.js";

// M130 (ISP) — narrowed from the composite `SpanRepository` to the exact roles used:
// trace-read (listTracesForTool) + aggregates (agents/tool-stats/cost).
export function registerAnalyticsRoutes(app: Hono, repo: TraceReadRepository & AggregateRepository): void {
  app.get("/v1/agents", requireScopeOnPrincipal("observability:read"), async (c) => {
    // M32: the agents catalog (derived from `agent.*` span attributes), with health.
    const agents = await repo.aggregateAgents(getPrincipal(c).workspaceId);
    return c.json(agentCatalogResponseSchema.parse({ agents }), 200);
  });

  app.get("/v1/analytics/tools", requireScopeOnPrincipal("observability:read"), async (c) => {
    const stats = await repo.aggregateToolStats(getPrincipal(c).workspaceId);
    return c.json(toolStatsResponseSchema.parse(stats), 200);
  });

  app.get("/v1/analytics/tools/:toolName/traces", requireScopeOnPrincipal("observability:read"), async (c) => {
    const list = await repo.listTracesForTool(
      c.req.param("toolName"),
      undefined,
      getPrincipal(c).workspaceId,
    );
    return c.json(traceListResponseSchema.parse(list), 200);
  });

  app.get("/v1/analytics/cost", requireScopeOnPrincipal("observability:read"), async (c) => {
    // Whitelist the period (fail-fast on anything but day/week, Rule 8); default day.
    const raw = c.req.query("period");
    if (raw !== undefined && raw !== "day" && raw !== "week") {
      return c.json(apiError("INVALID_QUERY", "invalid period (use day or week)"), 400);
    }
    const result = await repo.aggregateCostByPeriod(
      raw === "week" ? "week" : "day",
      getPrincipal(c).workspaceId,
    );
    return c.json(costByPeriodResponseSchema.parse(result), 200);
  });
}
