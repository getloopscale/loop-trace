/**
 * M33 (D5) — M26d dataset routes, extracted out of `app.ts` to keep it under the
 * 500-LoC budget (the M36 review's F5). Behaviour-preserving move: per-verb scope +
 * workspace-from-Principal (M22) are unchanged. The repo port is injected by `createApp`.
 */
import type { Hono } from "hono";

import {
  type SpanRepository,
  datasetsResponseSchema,
  datasetSchema,
  datasetDetailSchema,
  normalizeDatasetName,
} from "@usetheo/lens-core";

import { getPrincipal, requireScopeOnPrincipal } from "../auth/middleware.js";
import { datasetItemsAdded } from "../metrics.js";

export function registerDatasetRoutes(app: Hono, repo: SpanRepository): void {
  app.get("/v1/datasets", requireScopeOnPrincipal("observability:read"), async (c) => {
    // M26d: all datasets with their item counts, newest-first.
    const datasets = await repo.listDatasets(getPrincipal(c).workspaceId);
    return c.json(datasetsResponseSchema.parse({ datasets }), 200);
  });

  app.post("/v1/datasets", requireScopeOnPrincipal("observability:write"), async (c) => {
    // M26d: create-or-get a dataset by name (D1, idempotent). 400 on a blank name.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    const name = normalizeDatasetName((body as { name?: unknown })?.name);
    if (name === null) {
      return c.json({ error: "dataset name is required (1-120 chars after trim)" }, 400);
    }
    const dataset = await repo.createDataset(name, getPrincipal(c).workspaceId);
    return c.json(datasetSchema.parse(dataset), 200);
  });

  app.get("/v1/datasets/:datasetId", requireScopeOnPrincipal("observability:read"), async (c) => {
    // M26d: a dataset + its items (snapshot input/output), or 404 if absent.
    const detail = await repo.getDataset(
      c.req.param("datasetId"),
      getPrincipal(c).workspaceId,
    );
    return detail
      ? c.json(datasetDetailSchema.parse(detail), 200)
      : c.json({ error: "not found" }, 404);
  });

  app.post("/v1/datasets/:datasetId/items", requireScopeOnPrincipal("observability:write"), async (c) => {
    // M26d: add a trace to a dataset (snapshot at add-time, D2). 400 on a missing
    // traceId, 404 when the dataset OR the trace is absent (D3); idempotent otherwise.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid json body" }, 400);
    }
    const datasetId = c.req.param("datasetId");
    const ws = getPrincipal(c).workspaceId;
    const b = body as { traceId?: unknown; input?: unknown; output?: unknown };
    let ok: boolean;
    if (typeof b.traceId === "string" && b.traceId.length > 0) {
      // M26d: add an existing trace by reference (snapshot at add-time).
      ok = await repo.addDatasetItem(datasetId, b.traceId, ws);
    } else if (typeof b.input === "string") {
      // M55: a synthetic item from a playground replay — input/output supplied directly, no source
      // trace. `output` optional (a failed/empty replay may still be a curated negative example).
      const output = typeof b.output === "string" ? b.output : "";
      const MAX = 256 * 1024;
      if (b.input.length > MAX || output.length > MAX) {
        return c.json({ error: "input/output too large" }, 400);
      }
      ok = await repo.addSyntheticDatasetItem(datasetId, b.input, output, ws);
    } else {
      return c.json({ error: "traceId or input is required" }, 400);
    }
    if (!ok) return c.json({ error: "not found" }, 404);
    datasetItemsAdded.add(1);
    const detail = await repo.getDataset(datasetId, ws);
    // detail is non-null here (the dataset existed for the add to succeed).
    return c.json(datasetDetailSchema.parse(detail), 200);
  });

  app.delete("/v1/datasets/:datasetId/items/:traceId", requireScopeOnPrincipal("observability:delete"), async (c) => {
    // M26d: remove an item by (dataset, trace). Idempotent. Returns the dataset (404
    // only if the dataset itself is absent — a missing item is a no-op).
    const datasetId = c.req.param("datasetId");
    const ws = getPrincipal(c).workspaceId;
    await repo.removeDatasetItem(datasetId, c.req.param("traceId"), ws);
    const detail = await repo.getDataset(datasetId, ws);
    return detail
      ? c.json(datasetDetailSchema.parse(detail), 200)
      : c.json({ error: "not found" }, 404);
  });
}
