import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
// Test-only coupling to the engine (same rationale as m1-contract.test.ts): the drift gate
// rebuilds the live OpenAPI doc and asserts the committed snapshot still matches it. Under the
// contract vitest config, @looptrace/api resolves to src, so this reflects the current engine.
import { buildOpenApiDocument, createApp } from "@looptrace/api";
import type { SpanRepository } from "@looptrace/core";

// MUST match scripts/generate-types.ts so the rebuilt doc is byte-identical to the snapshot's.
const SNAPSHOT_VERSION = "sdk-snapshot";
const here = dirname(fileURLToPath(import.meta.url));
const snapshotPath = join(here, "..", "..", "openapi.snapshot.json");

/** A no-op repo — route mounting never invokes repo methods; only `app.routes` is read. */
const stubRepo = new Proxy({}, { get: () => async () => null }) as unknown as SpanRepository;

function freshDoc(): Record<string, unknown> {
  return buildOpenApiDocument(createApp(stubRepo).routes, SNAPSHOT_VERSION) as Record<
    string,
    unknown
  >;
}

describe("OpenAPI snapshot drift gate (M103)", () => {
  it("committed snapshot deep-equals a freshly-built engine doc", () => {
    const committed = JSON.parse(readFileSync(snapshotPath, "utf8")) as unknown;
    expect(committed).toEqual(freshDoc());
  });

  it("snapshot carries all 7 named read-response components", () => {
    const doc = freshDoc() as { components: { schemas: Record<string, unknown> } };
    const schemas = doc.components.schemas;
    for (const name of [
      "TraceListResponse",
      "Span",
      "ObservabilityResponse",
      "SessionListResponse",
      "CostByPeriodResponse",
      "ToolStatsResponse",
      "Dataset",
    ]) {
      expect(schemas, `missing named component ${name}`).toHaveProperty(name);
    }
  });

  // M117 — the 13 read-parity zod routes must surface their named response components so the SDK
  // types are GENERATED (drift-gated), not hand-authored. test_openapi_document_contains_trace_cost_component.
  it("carries the 13 M117 read-parity zod response components", () => {
    const doc = freshDoc() as { components: { schemas: Record<string, unknown> } };
    const schemas = doc.components.schemas;
    for (const name of [
      "TraceCostResponse",
      "TraceTagsResponse",
      "AnnotationsResponse",
      "AgentCatalogResponse",
      "TraceListResponse",
      "NorthStarResponse",
      "EvaluatorsResponse",
      "ScoresResponse",
      "SpanFacetsResponse",
      "SessionDetailResponse",
      "DatasetDetail",
      "LabelingQueuePage",
      "LabelingQueueItem",
    ]) {
      expect(schemas, `missing M117 named component ${name}`).toHaveProperty(name);
    }
  });
});
