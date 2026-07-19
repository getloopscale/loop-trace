/**
 * M121 (D1) — replay-session north-star write + the metrics read surface (north-star / observability /
 * evaluators / scores / span-attributes), extracted verbatim out of `app.ts` to complete the
 * Front-Controller extraction. Behavior-preserving move: every route keeps its exact path, middleware
 * chain (bodyLimit413 -> per-verb scope guard -> handler), status codes, and response shape — the
 * `POST /v1/replay-sessions` cap + `replaySessionsRecorded` metric travel with the handler. Mirrors
 * `dataset-routes.ts`: workspace-from-Principal (M22); the repo port is injected by `createApp`.
 */
import type { Hono } from "hono";

import {
  type SpanRepository,
  northStarResponseSchema,
  observabilityRangeSchema,
  observabilityResponseSchema,
  evaluatorsResponseSchema,
  scoresResponseSchema,
  spanFacetsResponseSchema,
  isValidAttrKey,
  apiError,
} from "@usetheo/lens-core";

import { getPrincipal, requireScopeOnPrincipal } from "../auth/middleware.js";
import { bodyLimit413, DEFAULT_ADVANCED_MAX_BYTES } from "../body-caps.js"; // M118 (D1)
import { replaySessionsRecorded } from "../metrics.js";

export function registerMetricsRoutes(app: Hono, repo: SpanRepository): void {
  app.post("/v1/replay-sessions", bodyLimit413(DEFAULT_ADVANCED_MAX_BYTES), requireScopeOnPrincipal("observability:write"), async (c) => {
    // Record a replay-open event (M8 north-star). Fail-fast 400 on a missing
    // traceId (Rule 8); the UI calls this fire-and-forget so a 5xx never
    // degrades the replay UX (D3).
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(apiError("INVALID_BODY", "invalid json body"), 400);
    }
    const traceId = (body as { traceId?: unknown })?.traceId;
    if (typeof traceId !== "string" || traceId.length === 0) {
      return c.json(apiError("INVALID_BODY", "traceId is required"), 400);
    }
    await repo.recordReplaySession(traceId, getPrincipal(c).workspaceId);
    replaySessionsRecorded.add(1); // observable: replay-session north-star write volume (pillar c)
    return c.json({ recorded: true }, 200);
  });

  app.get("/v1/metrics/north-star", requireScopeOnPrincipal("observability:read"), async (c) => {
    const ns = await repo.aggregateNorthStar(getPrincipal(c).workspaceId);
    return c.json(northStarResponseSchema.parse(ns), 200);
  });

  app.get("/v1/metrics/observability", requireScopeOnPrincipal("observability:read"), async (c) => {
    // Validate the range at the boundary (fail-fast 400, Rule 8); default 24h.
    const raw = c.req.query("range");
    const parsed = observabilityRangeSchema.safeParse(raw ?? "24h");
    if (!parsed.success) {
      return c.json(apiError("INVALID_QUERY", "invalid range (use 1h|24h|7d|30d)"), 400);
    }
    const obs = await repo.aggregateObservability(
      parsed.data,
      getPrincipal(c).workspaceId,
    );
    return c.json(observabilityResponseSchema.parse(obs), 200);
  });

  app.get("/v1/metrics/evaluators", requireScopeOnPrincipal("observability:read"), async (c) => {
    // M26: per-evaluator aggregate (Online Evaluators cards). Range validated at the
    // boundary (Rule 8), same whitelist as observability; default 24h.
    const parsed = observabilityRangeSchema.safeParse(c.req.query("range") ?? "24h");
    if (!parsed.success) {
      return c.json(apiError("INVALID_QUERY", "invalid range (use 1h|24h|7d|30d)"), 400);
    }
    // Parse through the strict DTO at the boundary so the no-column-leak invariant
    // is enforced at runtime, uniform with every other read route (F-api-1).
    const summary = evaluatorsResponseSchema.parse({
      evaluators: await repo.aggregateEvaluators(
        parsed.data,
        getPrincipal(c).workspaceId,
      ),
    });
    return c.json(summary, 200);
  });

  app.get("/v1/metrics/scores", requireScopeOnPrincipal("observability:read"), async (c) => {
    // M90: per-evaluator score aggregation over time. Range validated at the boundary
    // (Rule 8), same whitelist as observability; default 24h. Parsed through the strict
    // DTO so the no-column-leak invariant holds at runtime (F-api-1).
    const parsed = observabilityRangeSchema.safeParse(c.req.query("range") ?? "24h");
    if (!parsed.success) {
      return c.json(apiError("INVALID_QUERY", "invalid range (use 1h|24h|7d|30d)"), 400);
    }
    const summary = scoresResponseSchema.parse({
      range: parsed.data,
      scores: await repo.aggregateScoresOverTime(
        parsed.data,
        getPrincipal(c).workspaceId,
      ),
    });
    return c.json(summary, 200);
  });

  app.get("/v1/metrics/span-attributes", requireScopeOnPrincipal("observability:read"), async (c) => {
    // M92 — facet discovery. No `key` → the workspace's top attribute keys; `?key=<k>` → the top
    // distinct values for that key. The key is bound as a jsonb path (injection-safe). Strict DTO.
    const ws = getPrincipal(c).workspaceId;
    const key = c.req.query("key");
    // Shape-validate the key at the boundary (fail-fast 400, Rule 8) — reject an oversized/hostile key
    // before it reaches SQL (it is bound regardless, but this caps abuse; same shape as the DSL clause).
    if (key !== undefined && key.length > 0 && !isValidAttrKey(key)) {
      return c.json(apiError("INVALID_QUERY", "invalid attribute key"), 400);
    }
    const body =
      key !== undefined && key.length > 0
        ? { mode: "values" as const, key, values: await repo.discoverSpanAttributeValues(key, ws) }
        : { mode: "keys" as const, keys: await repo.discoverSpanAttributeKeys(ws) };
    return c.json(spanFacetsResponseSchema.parse(body), 200);
  });
}
