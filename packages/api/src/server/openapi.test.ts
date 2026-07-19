import { describe, expect, test } from "vitest";

import { buildOpenApiDocument, type MountedRoute } from "./openapi.js";

/**
 * M126 — the OpenAPI document's `paths` byte-order MUST be deterministic (sorted), NOT a function of
 * route-registration order. Before this fix the generated snapshot byte-order tracked `app.routes`
 * insertion order, and the drift test compared content (order-blind) so a pure reorder silently forced a
 * regenerate-or-drift trap (issue #59). These tests pin the sort so a reorder can never change the emitted
 * bytes.
 */

// Two route sets with the SAME routes in DIFFERENT registration order + mixed methods on one path.
const routesA: MountedRoute[] = [
  { method: "GET", path: "/v1/traces" },
  { method: "POST", path: "/v1/runs" },
  { method: "GET", path: "/v1/datasets" },
  { method: "POST", path: "/v1/datasets" },
  { method: "GET", path: "/v1/traces/:id" },
];
const routesB: MountedRoute[] = [
  { method: "POST", path: "/v1/datasets" },
  { method: "GET", path: "/v1/traces/:id" },
  { method: "POST", path: "/v1/runs" },
  { method: "GET", path: "/v1/datasets" },
  { method: "GET", path: "/v1/traces" },
];

function pathsOf(doc: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return doc["paths"] as Record<string, Record<string, unknown>>;
}

describe("buildOpenApiDocument — deterministic path ordering (M126, #59)", () => {
  test("paths keys are emitted in sorted order regardless of route-registration order", () => {
    // Distinct version keys dodge the internal (routes-signature, version) memo cache.
    const paths = pathsOf(buildOpenApiDocument(routesA, "m126-a"));
    const keys = Object.keys(paths);
    expect(keys).toEqual([...keys].sort());
  });

  test("per-path method maps are emitted in sorted order", () => {
    const paths = pathsOf(buildOpenApiDocument(routesA, "m126-methods"));
    const methods = Object.keys(paths["/v1/datasets"]); // has get + post
    expect(methods).toEqual([...methods].sort());
    expect(methods).toEqual(["get", "post"]);
  });

  test("reordering the routes produces byte-identical paths (order-independence)", () => {
    const a = JSON.stringify(pathsOf(buildOpenApiDocument(routesA, "m126-stable-a")));
    const b = JSON.stringify(pathsOf(buildOpenApiDocument(routesB, "m126-stable-b")));
    expect(a).toBe(b);
  });
});
