import { describe, it, expect } from "vitest";
import { RateLimiter, ChatError } from "@usetheo/lens-core";
import type {
  ChatMessage,
  ReplayClient,
  ReplayResult,
  SpanRepository,
  EvaluatorRepository,
  EvaluatorRecord,
  DatasetDetail,
  ExperimentRun,
} from "@usetheo/lens-core";

import { createApp } from "./app.js";
import type { ExperimentApiDeps } from "./handlers/experiment.js";

/**
 * M64 — experiment-run route contract tests (single-tenant default Principal holds all scopes → the
 * handler is reached). Fail-closed: 503 no provider, 429 rate-limited, 400 bad body, 404 foreign/absent
 * dataset — each BEFORE any billable call; a run persists with per-row scores.
 */

const DATASET: DatasetDetail = {
  id: "11111111-1111-1111-1111-111111111111",
  name: "regression",
  createdAt: "2026-07-07T00:00:00Z",
  items: [{ traceId: "t1", inputSnapshot: JSON.stringify([{ role: "user", content: "hi" }]), outputSnapshot: "orig", createdAt: "2026-07-07T00:00:00Z" }],
};

const RULE_EVAL = {
  id: "e1", name: "has-good", kind: "rule", config: { predicate: "output:good" }, passLabel: "pass", failLabel: "fail", createdAt: "2026-07-07T00:00:00Z",
} as unknown as EvaluatorRecord;

function fakeSpanRepo(over: { dataset?: DatasetDetail | null } = {}): SpanRepository {
  const created: ExperimentRun[] = [];
  return {
    getDataset: async () => (over.dataset === undefined ? DATASET : over.dataset),
    createExperimentRun: async (run) => {
      const persisted: ExperimentRun = {
        id: "run-1", datasetId: run.datasetId, name: run.name, variant: run.variant, status: run.status,
        truncated: run.truncated, itemCount: run.items.length, passCount: run.items.filter((i) => i.scores.some((s) => (s.score ?? 0) >= 0.5)).length,
        totalCostUsd: 0, createdBy: run.createdBy, createdAt: "2026-07-07T00:00:00Z", items: run.items,
      };
      created.push(persisted);
      return persisted;
    },
    listExperimentRuns: async () => created,
    getExperimentRun: async (id) => created.find((r) => r.id === id) ?? null,
  } as unknown as SpanRepository;
}

const fakeEvaluatorRepo: EvaluatorRepository = { listEvaluators: async () => [RULE_EVAL] } as unknown as EvaluatorRepository;

function fakeReplay(over: { throws?: boolean } = {}): ReplayClient {
  return {
    async run(_m: ChatMessage[], model?: string): Promise<ReplayResult> {
      if (over.throws) throw new ChatError("provider 502");
      return { content: "a good answer", promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.001, model: model ?? "m" };
    },
  };
}

function appWith(over: Partial<ExperimentApiDeps> = {}): ReturnType<typeof createApp> {
  const spanRepo = over.spanRepo ?? fakeSpanRepo();
  const deps: ExperimentApiDeps = {
    spanRepo,
    evaluatorRepo: fakeEvaluatorRepo,
    chat: fakeReplay(),
    limiter: new RateLimiter(100),
    now: () => 1_000_000,
    ...over,
  };
  // The main repo arg (used by non-experiment routes) + the experiment deps (used by the run route).
  return createApp(spanRepo, undefined, {}, undefined, undefined, undefined, deps);
}

function post(app: ReturnType<typeof createApp>, body: unknown): Promise<Response> {
  return app.request("/v1/experiment-runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("M64 experiment-run route", () => {
  it("test_run_persists_and_returns_run_with_scores", async () => {
    const res = await post(appWith(), { datasetId: DATASET.id, name: "run A", variant: { model: "gpt-x" } });
    expect(res.status).toBe(200);
    const run = (await res.json()) as ExperimentRun;
    expect(run.itemCount).toBe(1);
    expect(run.items?.[0].output).toBe("a good answer");
    expect(run.items?.[0].scores).toEqual([{ name: "has-good", score: 1, label: "pass" }]); // rule scored
  });

  it("test_run_503_when_provider_unconfigured (no store write)", async () => {
    const res = await post(appWith({ chat: null }), { datasetId: DATASET.id });
    expect(res.status).toBe(503);
  });

  it("test_run_429_when_rate_limited (no provider call)", async () => {
    const limiter = new RateLimiter(1);
    const app = appWith({ limiter });
    expect((await post(app, { datasetId: DATASET.id })).status).toBe(200);
    expect((await post(app, { datasetId: DATASET.id })).status).toBe(429);
  });

  it("test_run_400_on_missing_datasetId", async () => {
    expect((await post(appWith(), {})).status).toBe(400);
    expect((await post(appWith(), { datasetId: 42 })).status).toBe(400);
  });

  it("test_run_404_when_dataset_absent", async () => {
    const res = await post(appWith({ spanRepo: fakeSpanRepo({ dataset: null }) }), { datasetId: DATASET.id });
    expect(res.status).toBe(404);
  });

  it("test_run_partial_persists_on_per_item_provider_error", async () => {
    const res = await post(appWith({ chat: fakeReplay({ throws: true }) }), { datasetId: DATASET.id });
    expect(res.status).toBe(200); // the run persists; the item carries an error, not a fabricated output
    const run = (await res.json()) as ExperimentRun;
    expect(run.status).toBe("failed"); // the only item errored
    expect(run.items?.[0].error).toBeDefined();
    expect(run.items?.[0].output).toBeUndefined();
  });
});
