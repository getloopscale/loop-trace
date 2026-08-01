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
  usageByUserResponseSchema,
  type UsageByUserOptions,
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

  // M140 — consumption grouped by END USER. Observability, not billing: theo-lens reports what it
  // observed; theo-cloud is what charges. The workspace comes from the Principal and never from a
  // query param — a `?workspaceId=` here would be a cross-tenant leak by design (M22).
  app.get("/v1/analytics/usage-by-user", requireScopeOnPrincipal("observability:read"), async (c) => {
    // Fail-fast on each param (Rule 8): a non-numeric or out-of-range value is rejected rather than
    // silently defaulted, so a caller never receives a window different from the one it asked for.
    const num = (name: string): number | undefined | null => {
      const raw = c.req.query(name);
      if (raw === undefined) return undefined;
      const n = Number(raw);
      return Number.isInteger(n) && n > 0 ? n : null;
    };
    const days = num("days");
    const limit = num("limit");
    const offset = c.req.query("offset") === undefined ? undefined : Number(c.req.query("offset"));
    if (days === null || limit === null) {
      return c.json(apiError("INVALID_QUERY", "days and limit must be positive integers"), 400);
    }
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
      return c.json(apiError("INVALID_QUERY", "offset must be a non-negative integer"), 400);
    }
    const opts: UsageByUserOptions = {};
    if (days !== undefined) opts.days = days;
    if (limit !== undefined) opts.limit = limit;
    if (offset !== undefined) opts.offset = offset;
    const result = await repo.aggregateUsageByUser(opts, getPrincipal(c).workspaceId);
    return c.json(usageByUserResponseSchema.parse(result), 200);
  });
}
