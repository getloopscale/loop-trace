import { describe, it, expect } from "vitest";
import type { AuthVerifier, Principal, SpanRepository } from "@usetheo/lens-core";
import { createApp } from "./app.js";
import type { EvaluatorApiDeps } from "./handlers/evaluators.js";
import type { CopilotApiDeps } from "./handlers/copilot.js";

/**
 * M37 scope×verb contract matrix refresh — representative routes across every
 * post-M22 surface (datasets, evaluators, guards, agents, analytics, metrics,
 * sessions, copilot). The decisive row is `platform-admin-only`: it implies ONLY
 * `lens:admin`, so it is 403 on EVERY data verb (the data-plane half of CWE-441).
 */

const TOKENS: Record<string, string[]> = {
  none: [], // (sent as no-credential below)
  read: ["lens:read"],
  write: ["lens:write"],
  delete: ["lens:delete"],
  full: ["lens:read", "lens:write", "lens:delete"],
  platformAdmin: ["lens:platform-admin"],
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

const app = createApp(
  repo,
  undefined,
  { verifier: verifier(), requireCredential: true },
  evaluatorDeps,
  copilotDeps,
);

type TokenClass = keyof typeof TOKENS;
type ScopeName = "lens:read" | "lens:write" | "lens:delete";

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
    requiredScope: "lens:read",
    successStatus: 200,
    build: () => new Request("http://x/v1/traces"),
  },
  {
    name: "trace-ingest",
    requiredScope: "lens:write",
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
    requiredScope: "lens:delete",
    successStatus: 200,
    build: () =>
      new Request("http://x/v1/traces/t1/tags?tag=x", { method: "DELETE" }),
  },
  {
    name: "agents-catalog",
    requiredScope: "lens:read",
    successStatus: 200,
    build: () => new Request("http://x/v1/agents"),
  },
  {
    name: "tool-analytics",
    requiredScope: "lens:read",
    successStatus: 200,
    build: () => new Request("http://x/v1/analytics/tools"),
  },
  {
    name: "observability-metrics",
    requiredScope: "lens:read",
    successStatus: 200,
    build: () => new Request("http://x/v1/metrics/observability?range=24h"),
  },
  {
    name: "sessions-list",
    requiredScope: "lens:read",
    successStatus: 200,
    build: () => new Request("http://x/v1/sessions"),
  },
  {
    name: "datasets-list",
    requiredScope: "lens:read",
    successStatus: 200,
    build: () => new Request("http://x/v1/datasets"),
  },
  {
    name: "datasets-create",
    requiredScope: "lens:write",
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
    requiredScope: "lens:delete",
    successStatus: 200,
    build: () =>
      new Request("http://x/v1/datasets/d1/items/t1", { method: "DELETE" }),
  },
  {
    name: "evaluators-list",
    requiredScope: "lens:read",
    successStatus: 200,
    build: () => new Request("http://x/v1/evaluators"),
  },
  {
    name: "evaluators-create",
    requiredScope: "lens:write",
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
    requiredScope: "lens:delete",
    successStatus: 204,
    build: () =>
      new Request("http://x/v1/evaluators/e1", { method: "DELETE" }),
  },
  {
    name: "guards-list",
    requiredScope: "lens:read",
    successStatus: 200,
    build: () => new Request("http://x/v1/guards"),
  },
  {
    name: "guards-create",
    requiredScope: "lens:write",
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
    requiredScope: "lens:delete",
    successStatus: 204,
    build: () =>
      new Request("http://x/v1/guards/g1", { method: "DELETE" }),
  },
  {
    name: "copilot-ask",
    requiredScope: "lens:read",
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
