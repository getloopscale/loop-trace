import { describe, it, expect } from "vitest";
import type { AuthVerifier, Principal, SpanRepository } from "@usetheo/lens-core";
import { createApp } from "./app.js";
import type { EvaluatorApiDeps } from "./handlers/evaluators.js";
import type { CopilotApiDeps } from "./handlers/copilot.js";
import type { ExperimentApiDeps } from "./handlers/experiment.js";

/**
 * M37 scope×verb contract matrix refresh — representative routes across every
 * post-M22 surface (datasets, evaluators, guards, agents, analytics, metrics,
 * sessions, copilot). The decisive row is `platform-admin-only`: it implies ONLY
 * `observability:admin`, so it is 403 on EVERY data verb (the data-plane half of CWE-441).
 */

const TOKENS: Record<string, string[]> = {
  none: [], // (sent as no-credential below)
  read: ["observability:read"],
  write: ["observability:write"],
  delete: ["observability:delete"],
  full: ["observability:read", "observability:write", "observability:delete"],
  platformAdmin: ["observability:platform-admin"],
};

function verifier(): AuthVerifier {
  const map: Record<string, Principal> = {};
  for (const [tok, scopes] of Object.entries(TOKENS)) {
    if (tok === "none") continue;
    map[tok] = { workspaceId: "ws", userId: "u", role: "member", scopes };
  }
  return {
     
    resolvePrincipal: async (t) => map[t] ?? null,
     
    verify: async (t) => map[t] !== undefined,
  };
}

const ISO_NOW = "2026-07-01T12:00:00.000Z";

const TRACE_TREE = {
  spanId: "s-root",
  traceId: "t1",
  name: "root",
  startTimeUnixNano: "1700000000000000000",
  endTimeUnixNano: "1700000000100000000",
  inputValue: "input",
  outputValue: "output",
  children: [],
};

const repo = {
  save: async () => undefined,
  listTraces: async () => ({ traces: [] }),
  getBySpanId: async () => null,
  getTraceCost: async () => ({
    traceId: "t1",
    totalCostUsd: 0,
    byModel: [],
  }),
  getTraceTree: async () => TRACE_TREE,
  aggregateAgents: async () => [],
  aggregateToolStats: async () => ({ tools: [] }),
  listTracesForTool: async () => ({ traces: [] }),
  aggregateCostByPeriod: async () => ({ period: "day", buckets: [] }),
  recordReplaySession: async () => undefined,
  aggregateNorthStar: async () => ({ tracesPerDay: [], replaySessionsPerWeek: [] }),
  aggregateObservability: async (range = "24h") => ({
    range,
    traffic: [],
    latency: [],
    tokensByModel: [],
  }),
  aggregateEvaluators: async () => [],
  listSessions: async () => ({ sessions: [] }),
  getSessionDetail: async () => null,
  listTags: async () => [],
  addTag: async () => true,
  removeTag: async () => undefined,
  listAnnotations: async () => [],
  upsertAnnotation: async () => true,
  removeAnnotation: async () => undefined,
  listDatasets: async () => [],
  createDataset: async () => ({
    id: "d1",
    name: "seed",
    createdAt: ISO_NOW,
    itemCount: 0,
  }),
  getDataset: async () => ({
    id: "d1",
    name: "seed",
    createdAt: ISO_NOW,
    items: [],
  }),
  addDatasetItem: async () => true,
  removeDatasetItem: async () => undefined,
  // M63 labeling-queue stubs (success shapes; the matrix asserts the SCOPE guard, not the store).
  enqueueLabelingItem: async () => ({
    id: "i1", traceId: "t1", spanId: "s1", status: "pending", createdBy: "u", createdAt: ISO_NOW,
  }),
  listLabelingQueue: async () => ({ items: [], total: 0, page: 1, pageSize: 50 }),
  getLabelingQueueItem: async () => ({
    id: "i1", traceId: "t1", spanId: "s1", status: "resolved", label: "good", createdBy: "u", createdAt: ISO_NOW,
  }),
  resolveLabelingItem: async () => true,
  exportResolvedAsDataset: async () => ({ id: "d1", name: "golden", createdAt: ISO_NOW, itemCount: 0 }),
} as unknown as SpanRepository;

const evaluatorDeps = {
  repo: {
    createEvaluator: async () => ({
      id: "e1",
      name: "q",
      kind: "rule",
      config: { predicate: "status:error" },
      target: "",
      enabled: true,
      createdAt: ISO_NOW,
    }),
    listEvaluators: async () => [],
    getEvaluator: async () => ({
      id: "e1",
      name: "q",
      kind: "rule",
      config: { predicate: "status:error" },
      target: "",
      enabled: true,
      createdAt: ISO_NOW,
    }),
    deleteEvaluator: async () => undefined,
    createGuard: async () => ({
      id: "g1",
      evaluatorId: "e1",
      operator: "lt",
      threshold: 0.5,
      enabled: true,
      createdAt: ISO_NOW,
    }),
    listGuards: async () => [],
    deleteGuard: async () => undefined,
    listBreachingTraces: async () => [],
  },
  engine: {
    evaluatorRepo: {} as never,
    spanRepo: repo,
    judge: null,
    backfillMax: 1,
  },
} as unknown as EvaluatorApiDeps;

const copilotDeps = {
  spanRepo: repo,
  chat: { ask: async () => "grounded answer" },
  limiter: { tryAcquire: () => true },
} as unknown as CopilotApiDeps;

// M64 experiment deps — a 1-item dataset + a fast fake chat so a `write`-token run reaches 200.
const experimentDeps = {
  spanRepo: {
    getDataset: async () => ({ id: "d1", name: "seed", createdAt: ISO_NOW, items: [{ traceId: "t1", inputSnapshot: "[]", outputSnapshot: "o", createdAt: ISO_NOW }] }),
    createExperimentRun: async (run: { datasetId: string; name: string; variant: unknown; status: string; truncated: boolean; createdBy: string; items: unknown[] }) => ({
      id: "run-1", datasetId: run.datasetId, name: run.name, variant: run.variant, status: run.status, truncated: run.truncated,
      itemCount: run.items.length, passCount: 0, totalCostUsd: 0, createdBy: run.createdBy, createdAt: ISO_NOW, items: run.items,
    }),
    listExperimentRuns: async () => [],
    getExperimentRun: async () => null,
  },
  evaluatorRepo: { listEvaluators: async () => [] },
  chat: { run: async () => ({ content: "ok", promptTokens: 1, completionTokens: 1, totalTokens: 2, model: "m" }) },
  limiter: { tryAcquire: () => true },
} as unknown as ExperimentApiDeps;

const app = createApp(
  repo,
  undefined,
  { verifier: verifier(), requireCredential: true },
  evaluatorDeps,
  copilotDeps,
  undefined,
  experimentDeps,
);

type TokenClass = keyof typeof TOKENS;
type ScopeName = "observability:read" | "observability:write" | "observability:delete";

type MatrixCase = {
  readonly name: string;
  readonly requiredScope: ScopeName;
  readonly successStatus: number;
  readonly build: () => Request;
};

const OTLP = JSON.stringify({
  resourceSpans: [{ scopeSpans: [{ spans: [] }] }],
});

const CASES: readonly MatrixCase[] = [
  {
    name: "traces-list",
    requiredScope: "observability:read",
    successStatus: 200,
    build: () => new Request("http://x/v1/traces"),
  },
  {
    name: "trace-ingest",
    requiredScope: "observability:write",
    successStatus: 200,
    build: () =>
      new Request("http://x/v1/traces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: OTLP,
      }),
  },
  {
    name: "tags-delete",
    requiredScope: "observability:delete",
    successStatus: 200,
    build: () =>
      new Request("http://x/v1/traces/t1/tags?tag=x", { method: "DELETE" }),
  },
  {
    name: "agents-catalog",
    requiredScope: "observability:read",
    successStatus: 200,
    build: () => new Request("http://x/v1/agents"),
  },
  {
    name: "tool-analytics",
    requiredScope: "observability:read",
    successStatus: 200,
    build: () => new Request("http://x/v1/analytics/tools"),
  },
  {
    name: "observability-metrics",
    requiredScope: "observability:read",
    successStatus: 200,
    build: () => new Request("http://x/v1/metrics/observability?range=24h"),
  },
  {
    name: "sessions-list",
    requiredScope: "observability:read",
    successStatus: 200,
    build: () => new Request("http://x/v1/sessions"),
  },
  {
    name: "datasets-list",
    requiredScope: "observability:read",
    successStatus: 200,
    build: () => new Request("http://x/v1/datasets"),
  },
  {
    name: "datasets-create",
    requiredScope: "observability:write",
    successStatus: 200,
    build: () =>
      new Request("http://x/v1/datasets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "seed" }),
      }),
  },
  {
    name: "datasets-delete-item",
    requiredScope: "observability:delete",
    successStatus: 200,
    build: () =>
      new Request("http://x/v1/datasets/d1/items/t1", { method: "DELETE" }),
  },
  // M63 labeling queues — the CWE-441 second half: read for list/get, write for enqueue/resolve/export.
  {
    name: "labeling-queue-list",
    requiredScope: "observability:read",
    successStatus: 200,
    build: () => new Request("http://x/v1/labeling-queue"),
  },
  {
    name: "labeling-queue-get",
    requiredScope: "observability:read",
    successStatus: 200,
    build: () => new Request("http://x/v1/labeling-queue/i1"),
  },
  {
    name: "labeling-queue-enqueue",
    requiredScope: "observability:write",
    successStatus: 200,
    build: () =>
      new Request("http://x/v1/traces/t1/enqueue-for-labeling", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spanId: "s1" }),
      }),
  },
  {
    name: "labeling-queue-resolve",
    requiredScope: "observability:write",
    successStatus: 200,
    build: () =>
      new Request("http://x/v1/labeling-queue/i1/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "good", score: 0.9 }),
      }),
  },
  {
    name: "labeling-queue-export",
    requiredScope: "observability:write",
    successStatus: 200,
    build: () =>
      new Request("http://x/v1/labeling-queue/export-as-dataset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "golden-set" }),
      }),
  },
  // M64 experiment runs — write for create-run (billable), read for list/get/compare.
  {
    name: "experiment-run-create",
    requiredScope: "observability:write",
    successStatus: 200,
    build: () =>
      new Request("http://x/v1/experiment-runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ datasetId: "d1", variant: { model: "m" } }),
      }),
  },
  {
    name: "experiment-run-list",
    requiredScope: "observability:read",
    successStatus: 200,
    build: () => new Request("http://x/v1/experiment-runs"),
  },
  {
    name: "experiment-run-compare",
    requiredScope: "observability:read",
    successStatus: 200,
    build: () => new Request("http://x/v1/experiment-runs/compare?ids=a,b"),
  },
  {
    name: "experiment-run-get",
    requiredScope: "observability:read",
    successStatus: 404,
    build: () => new Request("http://x/v1/experiment-runs/00000000-0000-0000-0000-000000000000"),
  },
  {
    name: "evaluators-list",
    requiredScope: "observability:read",
    successStatus: 200,
    build: () => new Request("http://x/v1/evaluators"),
  },
  {
    name: "evaluators-create",
    requiredScope: "observability:write",
    successStatus: 200,
    build: () =>
      new Request("http://x/v1/evaluators", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "q",
          kind: "rule",
          config: { predicate: "status:error" },
        }),
      }),
  },
  {
    name: "evaluators-delete",
    requiredScope: "observability:delete",
    successStatus: 204,
    build: () =>
      new Request("http://x/v1/evaluators/e1", { method: "DELETE" }),
  },
  {
    name: "guards-list",
    requiredScope: "observability:read",
    successStatus: 200,
    build: () => new Request("http://x/v1/guards"),
  },
  {
    name: "guards-create",
    requiredScope: "observability:write",
    successStatus: 200,
    build: () =>
      new Request("http://x/v1/guards", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          evaluatorId: "e1",
          operator: "lt",
          threshold: 0.5,
        }),
      }),
  },
  {
    name: "guards-delete",
    requiredScope: "observability:delete",
    successStatus: 204,
    build: () =>
      new Request("http://x/v1/guards/g1", { method: "DELETE" }),
  },
  {
    name: "copilot-ask",
    requiredScope: "observability:read",
    successStatus: 200,
    build: () =>
      new Request("http://x/v1/traces/t1/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "why?" }),
      }),
  },
];

function expectedStatus(tokenClass: TokenClass, requiredScope: ScopeName, successStatus: number): number {
  if (tokenClass === "none") return 401;
  if (tokenClass === "platformAdmin") return 403;
  if (tokenClass === "full") return successStatus;
  return TOKENS[tokenClass].includes(requiredScope) ? successStatus : 403;
}

describe("M37 scope×verb matrix", () => {
  for (const matrixCase of CASES) {
    for (const tokenClass of Object.keys(TOKENS) as TokenClass[]) {
      const status = expectedStatus(
        tokenClass,
        matrixCase.requiredScope,
        matrixCase.successStatus,
      );
      it(`${matrixCase.name}: token=${tokenClass} → ${status}`, async () => {
        const req = matrixCase.build();
        if (tokenClass !== "none") {
          req.headers.set("authorization", `Bearer ${tokenClass}`);
        }
        const res = await app.request(req);
        expect(res.status).toBe(status);
      });
    }
  }
});
