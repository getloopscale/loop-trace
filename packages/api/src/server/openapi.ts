/**
 * M96 — the machine-readable API contract. The component schemas are GENERATED from the existing
 * Zod DTOs (Rule 9 — never a hand-maintained spec); the path list is derived from the LIVE Hono
 * router (`app.routes`) so it can never drift from what is actually mounted. A customer developer
 * fetches `/openapi.json`, generates a client, and integrates without reading TypeScript.
 */
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  costByPeriodResponseSchema,
  datasetSchema,
  observabilityResponseSchema,
  sessionListResponseSchema,
  spanSchema,
  toolStatsResponseSchema,
  traceListResponseSchema,
} from "@usetheo/lens-core";

extendZodWithOpenApi(z);

/**
 * Named response DTOs surfaced as OpenAPI components (generated from the Zod source of truth).
 * Built lazily (at request time, not module load) so importing this module does no work and does
 * not touch the core DTO exports — keeps composition-root boot tests that mock `@usetheo/lens-core`
 * from tripping on an unused export.
 */
function namedSchemas(): Record<string, z.ZodTypeAny> {
  const apiErrorSchema = z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.array(z.object({ field: z.string(), issue: z.string() })).optional(),
    })
    .openapi("ApiError");
  return {
    ApiError: apiErrorSchema,
    Span: spanSchema,
    TraceListResponse: traceListResponseSchema,
    ObservabilityResponse: observabilityResponseSchema,
    SessionListResponse: sessionListResponseSchema,
    CostByPeriodResponse: costByPeriodResponseSchema,
    ToolStatsResponse: toolStatsResponseSchema,
    Dataset: datasetSchema,
  };
}

/** Which named response component a mounted route returns on 200 (best-effort, extend as routes grow). */
const RESPONSE_FOR_ROUTE: Record<string, string> = {
  "GET /v1/traces": "TraceListResponse",
  "GET /v1/spans/:spanId": "Span",
  "GET /v1/metrics/observability": "ObservabilityResponse",
  "GET /v1/sessions": "SessionListResponse",
  "GET /v1/analytics/cost": "CostByPeriodResponse",
  "GET /v1/analytics/tools": "ToolStatsResponse",
  "GET /v1/datasets": "Dataset",
};

const HONO_PARAM = /:([A-Za-z0-9_]+)/g;
/** `/v1/spans/:id` → `/v1/spans/{id}` + the extracted path-param names. */
function toOpenApiPath(honoPath: string): { path: string; params: string[] } {
  const params: string[] = [];
  const path = honoPath.replace(HONO_PARAM, (_, name: string) => {
    params.push(name);
    return `{${name}}`;
  });
  return { path, params };
}

/** Routes that are not part of the documented public data surface. */
const EXCLUDED = new Set(["/health", "/ready", "/openapi.json", "/v1", "/version", "/*"]);

/**
 * A route excluded from the PUBLIC spec. Beyond the infra/discovery set, the admin key-lifecycle
 * surface (`/v1/admin/*`) is deliberately kept out of the unauthenticated `/openapi.json` — it is a
 * platform-admin (Model B broker) surface, not part of a customer client, and publishing the
 * mint/revoke routes to anonymous clients is needless reconnaissance exposure (least privilege).
 */
function isExcluded(path: string): boolean {
  return EXCLUDED.has(path) || path.startsWith("/v1/admin");
}

export interface MountedRoute {
  method: string;
  path: string;
}

/**
 * M102 (M96 F5) — memoize the generated document by (routes signature, version). The route set is
 * fixed once the app is built, so `/openapi.json` (an unauthenticated endpoint) rebuilds the spec at
 * most once per distinct signature instead of on every request. Bounded (one entry per app shape).
 */
const docCache = new Map<string, Record<string, unknown>>();

/**
 * Build the OpenAPI 3 document. `routes` is `app.routes` from the live Hono app, so the path list
 * always matches what is mounted. `version` stamps `info.version`. Memoized (see docCache).
 */
export function buildOpenApiDocument(routes: MountedRoute[], version = "dev"): Record<string, unknown> {
  const cacheKey = `${version}\n${routes.map((r) => `${r.method} ${r.path}`).join("\n")}`;
  const cached = docCache.get(cacheKey);
  if (cached) return cached;
  const doc = generateOpenApiDocument(routes, version);
  docCache.set(cacheKey, doc);
  return doc;
}

function generateOpenApiDocument(routes: MountedRoute[], version: string): Record<string, unknown> {
  const registry = new OpenAPIRegistry();
  for (const [name, schema] of Object.entries(namedSchemas())) registry.register(name, schema);
  const components = new OpenApiGeneratorV3(registry.definitions).generateComponents();

  const errorRef = { $ref: "#/components/schemas/ApiError" };
  const errorResponse = (desc: string) => ({
    description: desc,
    content: { "application/json": { schema: errorRef } },
  });

  // De-dup by "METHOD /path"; skip Hono's ALL/HEAD duplicates and excluded infra routes.
  const seen = new Set<string>();
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    if (r.method === "ALL" || r.method === "HEAD") continue;
    if (isExcluded(r.path)) continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const { path, params } = toOpenApiPath(r.path);
    const okSchemaName = RESPONSE_FOR_ROUTE[key];
    const okContent = okSchemaName
      ? { "application/json": { schema: { $ref: `#/components/schemas/${okSchemaName}` } } }
      : { "application/json": { schema: { type: "object" } } };

    const op: Record<string, unknown> = {
      summary: key,
      responses: {
        "200": { description: "OK", content: okContent },
        "400": errorResponse("Validation failure — see details[]"),
        "401": errorResponse("Missing or invalid credential"),
        "403": errorResponse("Scope not permitted"),
        "404": errorResponse("Not found"),
      },
    };
    if (params.length > 0) {
      op["parameters"] = params.map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      }));
    }
    (paths[path] ??= {})[r.method.toLowerCase()] = op;
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "Theo Lens API",
      version,
      description:
        "Tenant-isolated observability engine. Errors use the {code,message,details?} envelope. " +
        "List responses are paginated as {items,total,limit,offset}. Query params are snake_case; " +
        "JSON response fields are camelCase. A 400 covers both syntactic and semantic validation " +
        "failures at the engine boundary (the edge/BFF maps browser-actionable upstreams separately).",
    },
    paths,
    components: components.components,
  };
}
