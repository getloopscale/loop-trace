/**
 * M63 — Labeling-queue routes (Annotate → review queue → golden dataset). Mirrors `dataset-routes.ts`:
 * per-verb scope + workspace-from-Principal (M22), the repo port injected by `createApp`. This is the
 * CWE-441 second half — every verb mounts `requireScopeOnPrincipal` (read for list/get, write for
 * enqueue/resolve/export); the workspace is ALWAYS the resolved Principal's, never the body/params.
 */
import type { Hono } from "hono";

import {
  type LabelingQueueRepository,
  labelingQueueItemSchema,
  labelingQueuePageSchema,
  normalizeLabelResolution,
  type LabelingQueueStatus,
  apiError,
} from "@looptrace/core";

import { getPrincipal, requireScopeOnPrincipal } from "../auth/middleware.js";
import { labelingItemsEnqueued, labelingItemsResolved, labelingQueueExports } from "../metrics.js";
import { bodyLimit413, DEFAULT_ADVANCED_MAX_BYTES } from "../body-caps.js"; // M118 (D1) — small-body 64 KiB cap

const EXPORT_NAME_MAX = 120;

// M130 (ISP) — narrowed from the composite `SpanRepository` to the single role used: labeling queue.
export function registerLabelingQueueRoutes(app: Hono, repo: LabelingQueueRepository): void {
  app.get("/v1/labeling-queue", requireScopeOnPrincipal("observability:read"), async (c) => {
    // Server-paginated, optionally status-filtered. Params whitelisted; always workspace-scoped.
    const statusRaw = c.req.query("status");
    const status: LabelingQueueStatus | undefined =
      statusRaw === "pending" || statusRaw === "resolved" ? statusRaw : undefined;
    const page = Number.parseInt(c.req.query("page") ?? "1", 10);
    const pageSize = Number.parseInt(c.req.query("pageSize") ?? "50", 10);
    const result = await repo.listLabelingQueue(
      {
        ...(status ? { status } : {}),
        page: Number.isFinite(page) ? page : 1,
        pageSize: Number.isFinite(pageSize) ? pageSize : 50,
      },
      getPrincipal(c).workspaceId,
    );
    return c.json(labelingQueuePageSchema.parse(result), 200);
  });

  app.get("/v1/labeling-queue/:itemId", requireScopeOnPrincipal("observability:read"), async (c) => {
    const item = await repo.getLabelingQueueItem(c.req.param("itemId"), getPrincipal(c).workspaceId);
    return item ? c.json(labelingQueueItemSchema.parse(item), 200) : c.json(apiError("NOT_FOUND", "not found"), 404);
  });

  app.post("/v1/traces/:traceId/enqueue-for-labeling", bodyLimit413(DEFAULT_ADVANCED_MAX_BYTES), requireScopeOnPrincipal("observability:write"), async (c) => {
    // Enqueue a span for review. 400 on a missing spanId; idempotent on (workspace, trace, span).
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(apiError("INVALID_BODY", "invalid json body"), 400);
    }
    const spanId = (body as { spanId?: unknown })?.spanId;
    if (typeof spanId !== "string" || spanId.length === 0 || spanId.length > 256) {
      return c.json(apiError("INVALID_BODY", "spanId is required (1-256 chars)"), 400);
    }
    const p = getPrincipal(c);
    const item = await repo.enqueueLabelingItem(c.req.param("traceId"), spanId, p.userId ?? "unknown", p.workspaceId);
    labelingItemsEnqueued.add(1);
    return c.json(labelingQueueItemSchema.parse(item), 200);
  });

  app.post("/v1/labeling-queue/:itemId/resolve", bodyLimit413(DEFAULT_ADVANCED_MAX_BYTES), requireScopeOnPrincipal("observability:write"), async (c) => {
    // Resolve with a label/score/note. 400 on a blank label (an empty resolution is not a review),
    // 404 when the item is absent / another workspace.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(apiError("INVALID_BODY", "invalid json body"), 400);
    }
    const resolution = normalizeLabelResolution(body);
    if (resolution === null) {
      return c.json(apiError("INVALID_BODY", "a non-empty label is required to resolve"), 400);
    }
    const p = getPrincipal(c);
    const ok = await repo.resolveLabelingItem(c.req.param("itemId"), resolution, p.userId ?? "unknown", p.workspaceId);
    if (!ok) return c.json(apiError("NOT_FOUND", "not found"), 404);
    labelingItemsResolved.add(1);
    const item = await repo.getLabelingQueueItem(c.req.param("itemId"), p.workspaceId);
    return c.json(labelingQueueItemSchema.parse(item), 200);
  });

  app.post("/v1/labeling-queue/export-as-dataset", bodyLimit413(DEFAULT_ADVANCED_MAX_BYTES), requireScopeOnPrincipal("observability:write"), async (c) => {
    // Export the workspace's RESOLVED items as a golden dataset (reuses M44). 400 on a blank name.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(apiError("INVALID_BODY", "invalid json body"), 400);
    }
    const nameRaw = (body as { name?: unknown })?.name;
    const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
    if (name.length === 0 || name.length > EXPORT_NAME_MAX) {
      return c.json(apiError("INVALID_BODY", `dataset name is required (1-${EXPORT_NAME_MAX} chars after trim)`), 400);
    }
    const dataset = await repo.exportResolvedAsDataset(name, getPrincipal(c).workspaceId);
    labelingQueueExports.add(1);
    return c.json(dataset, 200);
  });
}
