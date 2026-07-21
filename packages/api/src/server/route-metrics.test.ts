import { beforeEach, describe, expect, it } from "vitest";
import { RateLimiter, EvaluatorRunJobRegistry, type EvaluatorRecord, type MonitorRecord } from "@usetheo/lens-core";

import { createApp } from "./app.js";
import type { EvaluatorApiDeps } from "./handlers/evaluators.js";
import {
  evaluatorRunsStarted,
  evaluatorsCreated,
  monitorsCreated,
  datasetsCreated,
  datasetsRenamed,
  datasetsDeleted,
  datasetItemsRemoved,
  tagsAdded,
  tagsRemoved,
  annotationsRemoved,
  replaySessionsRecorded,
} from "./metrics.js";

/**
 * M118 (T2.2) — every mutating advanced route that emitted no counter now increments a distinct one
 * (wiring-triad pillar c). Parameterized: capture `counter.value`, drive one happy call, assert +1.
 */

// A stub repo covering exactly the routes exercised here (create/rename/delete + tag/annotation writes +
// replay-session + evaluator/guard create + evaluator-run). Every method returns a happy value.
function stubRepo(): never {
  const created = new Map<string, unknown>();
  const impl: Record<string, (...a: unknown[]) => unknown> = {
    // datasets
    createDataset: async (name: string) => ({ id: "ds-1", name, createdAt: "2026-07-07T00:00:00Z", itemCount: 0 }),
    renameDataset: async (_id: string, name: string) => ({ id: "ds-1", name, createdAt: "2026-07-07T00:00:00Z", itemCount: 0 }),
    deleteDataset: async () => true,
    getDataset: async (id: string) => ({ id, name: "d", createdAt: "2026-07-07T00:00:00Z", items: [] }),
    removeDatasetItem: async () => {},
    // tags
    addTag: async () => true,
    listTags: async () => [],
    removeTag: async () => {},
    // annotations
    removeAnnotation: async () => {},
    listAnnotations: async () => [],
    // replay-session
    recordReplaySession: async (traceId: string) => { created.set(traceId, true); },
  };
  return new Proxy(impl, {
    get: (t, p: string) => t[p] ?? (async () => null),
  }) as never;
}

const EVAL: EvaluatorRecord = {
  id: "e1", name: "has-good", kind: "rule", config: { predicate: "" }, target: "", enabled: true, createdAt: "2026-07-07T00:00:00Z",
} as unknown as EvaluatorRecord;
const GUARD: MonitorRecord = {
  id: "g1", evaluatorId: "e1", operator: "lt", threshold: 0.5, enabled: true, createdAt: "2026-07-07T00:00:00Z",
} as unknown as MonitorRecord;

function evaluatorDeps(): EvaluatorApiDeps {
  const repo = {
    getEvaluator: async () => EVAL,
    createEvaluator: async () => EVAL,
    createMonitor: async () => GUARD,
    writeVerdict: async () => {},
  } as unknown as EvaluatorApiDeps["repo"];
  const engine = {
    evaluatorRepo: repo,
    spanRepo: { listTraces: async () => ({ traces: [] }), getTraceTree: async () => null },
    judge: null,
    backfillMax: 500,
  } as unknown as EvaluatorApiDeps["engine"];
  return { repo, engine, runJobs: new EvaluatorRunJobRegistry(), limiter: new RateLimiter(1000), now: () => 1 };
}

function buildApp(): ReturnType<typeof createApp> {
  const repo = stubRepo();
  return createApp(repo, undefined, {}, evaluatorDeps());
}

async function json(app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

interface Case {
  name: string;
  counter: { value: number };
  drive: (app: ReturnType<typeof createApp>) => Promise<Response>;
}

const CASES: Case[] = [
  { name: "evaluatorRunsStarted", counter: evaluatorRunsStarted, drive: (a) => json(a, "POST", "/v1/evaluators/e1/run", {}) },
  { name: "evaluatorsCreated", counter: evaluatorsCreated, drive: (a) => json(a, "POST", "/v1/evaluators", { name: "has-good", kind: "rule", config: { predicate: "" } }) },
  { name: "monitorsCreated", counter: monitorsCreated, drive: (a) => json(a, "POST", "/v1/guards", { evaluatorId: "e1", operator: "lt", threshold: 0.5 }) },
  { name: "datasetsCreated", counter: datasetsCreated, drive: (a) => json(a, "POST", "/v1/datasets", { name: "regression" }) },
  { name: "datasetsRenamed", counter: datasetsRenamed, drive: (a) => json(a, "PUT", "/v1/datasets/ds-1", { name: "renamed" }) },
  { name: "datasetsDeleted", counter: datasetsDeleted, drive: (a) => json(a, "DELETE", "/v1/datasets/ds-1") },
  { name: "datasetItemsRemoved", counter: datasetItemsRemoved, drive: (a) => json(a, "DELETE", "/v1/datasets/ds-1/items/t1") },
  { name: "tagsAdded", counter: tagsAdded, drive: (a) => json(a, "POST", "/v1/traces/t1/tags", { tag: "prod" }) },
  { name: "tagsRemoved", counter: tagsRemoved, drive: (a) => json(a, "DELETE", "/v1/traces/t1/tags?tag=prod") },
  { name: "annotationsRemoved", counter: annotationsRemoved, drive: (a) => json(a, "DELETE", "/v1/traces/t1/annotations?name=feedback") },
  { name: "replaySessionsRecorded", counter: replaySessionsRecorded, drive: (a) => json(a, "POST", "/v1/replay-sessions", { traceId: "t1" }) },
];

describe("M118 runtime metric on every unmetered mutating route", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = buildApp();
    for (const c of CASES) c.counter.reset?.();
  });

  it("covers_at_least_11_routes", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(11);
  });

  for (const c of CASES) {
    it(`test_mutating_route_increments_its_counter [${c.name}]`, async () => {
      const before = c.counter.value;
      const res = await c.drive(app);
      // The happy call must succeed (2xx) so the counter increment is the observed effect.
      expect(res.status, `${c.name} → ${res.status} ${await res.clone().text()}`).toBeLessThan(300);
      expect(c.counter.value).toBe(before + 1);
    });
  }
});
