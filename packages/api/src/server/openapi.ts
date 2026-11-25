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
  agentCatalogResponseSchema,
  annotationsResponseSchema,
  costByPeriodResponseSchema,
  usageByUserResponseSchema,
  datasetDetailSchema,
  datasetSchema,
  datasetsResponseSchema,
  evaluatorsResponseSchema,
  labelingQueueItemSchema,
  labelingQueuePageSchema,
  northStarResponseSchema,
  observabilityResponseSchema,
  scoresResponseSchema,
  sessionDetailResponseSchema,
  sessionListResponseSchema,
  spanFacetsResponseSchema,
  spanSchema,
  toolStatsResponseSchema,
  traceCostSchema,
  traceListResponseSchema,
  traceTagsResponseSchema,
  // M118 (D4) — advanced WRITE response components (server-side zod → GENERATED SDK types).
  evaluatorRecordSchema,
  evaluatorsListResponseSchema,
  monitorRecordSchema,
  monitorsListResponseSchema,
  runResultResponseSchema,
  experimentRunSchema,
  experimentRunsListResponseSchema,
  experimentCompareResponseSchema,
  askCopilotResponseSchema,
  copilotFeedbackRecordSchema,
  replayResponseSchema,
} from "@looptrace/core";

extendZodWithOpenApi(z);

/**
 * Named response DTOs surfaced as OpenAPI components (generated from the Zod source of truth).
 * Built lazily (at request time, not module load) so importing this module does no work and does
 * not touch the core DTO exports — keeps composition-root boot tests that mock `@looptrace/core`
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
    UsageByUserResponse: usageByUserResponseSchema,
    ToolStatsResponse: toolStatsResponseSchema,
    Dataset: datasetSchema,
    DatasetsResponse: datasetsResponseSchema,
    DatasetDetail: datasetDetailSchema,
    TraceTagsResponse: traceTagsResponseSchema,
    AnnotationsResponse: annotationsResponseSchema,
    // M117 — read-parity zod response components (the GENERATED half of ADR D1). Each is a route that
    // `.parse()`s a zod DTO, so surfacing it as a named component lets `openapi-typescript` emit a
    // typed schema the SDK aliases (drift-gated) instead of a hand-authored type that can drift.
    TraceCostResponse: traceCostSchema,
    AgentCatalogResponse: agentCatalogResponseSchema,
    NorthStarResponse: northStarResponseSchema,
    EvaluatorsResponse: evaluatorsResponseSchema,
    ScoresResponse: scoresResponseSchema,
    SpanFacetsResponse: spanFacetsResponseSchema,
    SessionDetailResponse: sessionDetailResponseSchema,
    LabelingQueuePage: labelingQueuePageSchema,
    LabelingQueueItem: labelingQueueItemSchema,
    // M118 (D4) — advanced write response components.
    EvaluatorRecord: evaluatorRecordSchema,
    EvaluatorsListResponse: evaluatorsListResponseSchema,
    MonitorRecord: monitorRecordSchema,
    GuardsListResponse: monitorsListResponseSchema,
    RunResultResponse: runResultResponseSchema,
    ExperimentRun: experimentRunSchema,
    ExperimentRunsListResponse: experimentRunsListResponseSchema,
    ExperimentCompareResponse: experimentCompareResponseSchema,
    AskCopilotResponse: askCopilotResponseSchema,
    CopilotFeedbackRecord: copilotFeedbackRecordSchema,
    ReplayResponse: replayResponseSchema,
  };
}

/** Which named response component a mounted route returns on 200 (best-effort, extend as routes grow). */
const RESPONSE_FOR_ROUTE: Record<string, string> = {
  "GET /v1/traces": "TraceListResponse",
  "GET /v1/spans/:spanId": "Span",
  "GET /v1/metrics/observability": "ObservabilityResponse",
  "GET /v1/sessions": "SessionListResponse",
  "GET /v1/analytics/cost": "CostByPeriodResponse",
  "GET /v1/analytics/usage-by-user": "UsageByUserResponse",
  "GET /v1/analytics/tools": "ToolStatsResponse",
  "GET /v1/datasets": "DatasetsResponse",
  // M107 — write surface 2xx response components (request bodies are hand-written in the SDK).
  "POST /v1/datasets": "Dataset",
  "PUT /v1/datasets/:datasetId": "Dataset",
  "POST /v1/datasets/:datasetId/items": "DatasetDetail",
  "DELETE /v1/datasets/:datasetId/items/:traceId": "DatasetDetail",
  "POST /v1/traces/:traceId/tags": "TraceTagsResponse",
  "DELETE /v1/traces/:traceId/tags": "TraceTagsResponse",
  "POST /v1/traces/:traceId/annotations": "AnnotationsResponse",
  "DELETE /v1/traces/:traceId/annotations": "AnnotationsResponse",
  // M117 — read-parity zod response components (13 routes → GENERATED SDK types, ADR D1).
  "GET /v1/traces/:traceId/cost": "TraceCostResponse",
  "GET /v1/traces/:traceId/tags": "TraceTagsResponse",
  "GET /v1/traces/:traceId/annotations": "AnnotationsResponse",
  "GET /v1/agents": "AgentCatalogResponse",
  "GET /v1/analytics/tools/:toolName/traces": "TraceListResponse",
  "GET /v1/metrics/north-star": "NorthStarResponse",
  "GET /v1/metrics/evaluators": "EvaluatorsResponse",
  "GET /v1/metrics/scores": "ScoresResponse",
  "GET /v1/metrics/span-attributes": "SpanFacetsResponse",
  "GET /v1/sessions/:sessionId": "SessionDetailResponse",
  "GET /v1/datasets/:datasetId": "DatasetDetail",
  "GET /v1/labeling-queue": "LabelingQueuePage",
  "GET /v1/labeling-queue/:itemId": "LabelingQueueItem",
  // M118 (D4) — advanced write routes now carry a server-side zod response DTO (parsed at the boundary).
  "POST /v1/evaluators": "EvaluatorRecord",
  "GET /v1/evaluators": "EvaluatorsListResponse",
  "GET /v1/evaluators/:id": "EvaluatorRecord",
  "PUT /v1/evaluators/:id": "EvaluatorRecord",
  "POST /v1/evaluators/:id/run": "RunResultResponse",
  "POST /v1/guards": "MonitorRecord",
  "GET /v1/guards": "GuardsListResponse",
  "POST /v1/experiment-runs": "ExperimentRun",
  "GET /v1/experiment-runs": "ExperimentRunsListResponse",
  "GET /v1/experiment-runs/:runId": "ExperimentRun",
  "GET /v1/experiment-runs/compare": "ExperimentCompareResponse",
  "POST /v1/traces/:traceId/ask": "AskCopilotResponse",
  "POST /v1/traces/:traceId/ask/feedback": "CopilotFeedbackRecord",
  "POST /v1/traces/:traceId/replay": "ReplayResponse",
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

/**
 * Routes that are not part of the documented public data surface.
 *
 * B-117 — `/v1/health`, `/v1/health/ready` and `/v1/version` LEFT this set. They answer
 * unauthenticated to anyone who asks, so omitting them from the document hid nothing; it only
 * stopped the ecosystem contract checker — which reads the document and nothing else — from
 * seeing that this service has an operational surface at all.
 *
 * The `healthz` pair stays excluded: it is the same two answers under the pre-contract spelling,
 * and documenting both would publish two names for one thing to every generated client.
 *
 * The `/v1/admin` exclusion below is a different kind and stays. Those routes do NOT answer
 * without a credential, so keeping them out of an anonymous spec is least privilege rather than
 * obscurity.
 */
const EXCLUDED = new Set(["/v1/healthz", "/v1/healthz/ready", "/openapi.json", "/v1", "/*"]);

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
  // Freeze the cached doc so a future caller mutating the shared object can never poison the cache.
  const doc = Object.freeze(generateOpenApiDocument(routes, version));
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

  // M126 (#59) — emit `paths` and each path's method map in a DETERMINISTIC (sorted) order so the generated
  // snapshot byte-order never tracks route-registration order. Hono matches the served routes independently
  // of this document, so sorting is behavior-preserving for the API and only stabilizes the generated artifact.
  const sortedPaths: Record<string, Record<string, unknown>> = {};
  for (const path of Object.keys(paths).sort()) {
    const methods = paths[path]!;
    const sortedMethods: Record<string, unknown> = {};
    for (const method of Object.keys(methods).sort()) sortedMethods[method] = methods[method];
    sortedPaths[path] = sortedMethods;
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "LoopTrace API",
      version,
      description:
        "Tenant-isolated observability engine. Errors use the {code,message,details?} envelope. " +
        "List responses are paginated as {items,total,limit,offset}. Query params are snake_case; " +
        "JSON response fields are camelCase. A 400 covers both syntactic and semantic validation " +
        "failures at the engine boundary (the edge/BFF maps browser-actionable upstreams separately).",
    },
    paths: sortedPaths,
    components: components.components,
  };
}
