import { beforeEach, describe, expect, it } from "vitest";
import { RateLimiter } from "@looptrace/core";
import type { ChatClient, ReplayClient, ReplayResult, ChatMessage } from "@looptrace/core/provider";

import { createApp } from "./app.js";
import type { EvaluatorApiDeps } from "./handlers/evaluators.js";
import type { CopilotApiDeps } from "./handlers/copilot.js";
import type { ReplayApiDeps } from "./handlers/replay.js";
import type { ExperimentApiDeps } from "./handlers/experiment.js";
import {
  DEFAULT_ADVANCED_MAX_BYTES,
  REPLAY_MAX_BYTES,
  EXPERIMENT_MAX_BYTES,
  EVALUATOR_MAX_BYTES,
  DATASET_ITEM_MAX_BYTES,
  DATASET_NAME_MAX_BYTES,
} from "./body-caps.js";

/**
 * M118 (T1.1/T1.2) — pre-parse bodyLimit 413 coverage on EVERY buffering advanced write route. A body
 * of `maxSize + 1` bytes MUST be shed with `413 { code: "PAYLOAD_TOO_LARGE" }` before the handler runs;
 * a body AT `maxSize` MUST NOT 413 (behavior-preserving edge, D1). Parameterized over the whole route
 * set (Corner 3a) — one table drives the middleware registration and the 413 assertion.
 */

// Minimal stubs so every advanced route is mounted (the guard runs before the handler, so the stub
// bodies never need to do real work for the 413 path — an over-cap body 413s before reaching them).
const chatStub: ChatClient = { ask: async () => "ok" };
class FakeReplay implements ReplayClient {
  async run(_m: ChatMessage[], model?: string): Promise<ReplayResult> {
    return { output: "o", content: "o", promptTokens: 0, completionTokens: 0, totalTokens: 0, model: model ?? "m" } as unknown as ReplayResult;
  }
}

function anyRepo(): never {
  // A permissive stub: any method resolves to null/[] — enough to mount routes and reach the guard.
  return new Proxy({}, { get: () => async () => null }) as never;
}

function buildApp(): ReturnType<typeof createApp> {
  const repo = anyRepo();
  const evaluators: EvaluatorApiDeps = { repo, engine: {} as never };
  const copilot: CopilotApiDeps = { spanRepo: repo, chat: chatStub, limiter: new RateLimiter(1000), now: () => 1 };
  const replay: ReplayApiDeps = { spanRepo: repo, chat: new FakeReplay(), limiter: new RateLimiter(1000), now: () => 1 };
  const experiment: ExperimentApiDeps = { spanRepo: repo, evaluatorRepo: repo, chat: new FakeReplay(), limiter: new RateLimiter(1000), now: () => 1 };
  return createApp(repo, undefined, {}, evaluators, copilot, replay, experiment);
}

interface Row {
  method: "POST" | "PUT";
  path: string;
  maxSize: number;
}

// Corner 3a — the handler + route-module + app.ts routes that buffer via c.req.json() with no pre-parse cap.
const ROWS: Row[] = [
  // copilot (register-extra-routes)
  { method: "POST", path: "/v1/traces/t1/ask", maxSize: DEFAULT_ADVANCED_MAX_BYTES },
  { method: "POST", path: "/v1/traces/t1/ask/feedback", maxSize: DEFAULT_ADVANCED_MAX_BYTES },
  // replay
  { method: "POST", path: "/v1/traces/t1/replay", maxSize: REPLAY_MAX_BYTES },
  // experiment
  { method: "POST", path: "/v1/experiment-runs", maxSize: EXPERIMENT_MAX_BYTES },
  // evaluators + guards
  { method: "POST", path: "/v1/evaluators", maxSize: EVALUATOR_MAX_BYTES },
  { method: "PUT", path: "/v1/evaluators/e1", maxSize: EVALUATOR_MAX_BYTES },
  { method: "POST", path: "/v1/evaluators/e1/run", maxSize: EVALUATOR_MAX_BYTES },
  { method: "POST", path: "/v1/guards", maxSize: EVALUATOR_MAX_BYTES },
  // datasets
  { method: "POST", path: "/v1/datasets", maxSize: DATASET_NAME_MAX_BYTES },
  { method: "POST", path: "/v1/datasets/d1/items", maxSize: DATASET_ITEM_MAX_BYTES },
  { method: "PUT", path: "/v1/datasets/d1", maxSize: DATASET_NAME_MAX_BYTES },
  // labeling queue
  { method: "POST", path: "/v1/traces/t1/enqueue-for-labeling", maxSize: DEFAULT_ADVANCED_MAX_BYTES },
  { method: "POST", path: "/v1/labeling-queue/i1/resolve", maxSize: DEFAULT_ADVANCED_MAX_BYTES },
  { method: "POST", path: "/v1/labeling-queue/export-as-dataset", maxSize: DEFAULT_ADVANCED_MAX_BYTES },
  // app.ts advanced routes (T1.2 — tags/annotations/replay-sessions)
  { method: "POST", path: "/v1/traces/t1/tags", maxSize: DEFAULT_ADVANCED_MAX_BYTES },
  { method: "POST", path: "/v1/traces/t1/annotations", maxSize: DEFAULT_ADVANCED_MAX_BYTES },
  { method: "POST", path: "/v1/replay-sessions", maxSize: DEFAULT_ADVANCED_MAX_BYTES },
];

describe("M118 bodyLimit 413 on advanced write routes", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    app = buildApp();
  });

  it("has_a_413_row_for_every_newly_capped_route (>= 12)", () => {
    // The route set the DoD enumerates — the table must cover the whole Corner-3a set.
    expect(ROWS.length).toBeGreaterThanOrEqual(12);
  });

  for (const row of ROWS) {
    it(`test_post_route_body_over_cap_returns_413 [${row.method} ${row.path}]`, async () => {
      // A body of maxSize + 1 bytes (valid JSON so only the size guard can reject it) is shed with 413.
      const filler = "x".repeat(row.maxSize); // "{"p":"<filler>"}" is > maxSize+1 bytes
      const body = JSON.stringify({ p: filler });
      expect(Buffer.byteLength(body)).toBeGreaterThan(row.maxSize);
      const res = await app.request(row.path, {
        method: row.method,
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status).toBe(413);
      expect(((await res.json()) as { code: string }).code).toBe("PAYLOAD_TOO_LARGE");
    });

    it(`test_post_route_body_at_cap_passes [${row.method} ${row.path}]`, async () => {
      // A body AT exactly maxSize bytes must NOT 413 (behavior-preserving edge — the cap only moves
      // earlier). The handler may still 400/404/etc on the (deliberately minimal) body — we only assert
      // it is NOT the size guard that fired.
      const target = row.maxSize;
      const overhead = Buffer.byteLength(JSON.stringify({ p: "" }));
      const filler = "x".repeat(target - overhead);
      const body = JSON.stringify({ p: filler });
      expect(Buffer.byteLength(body)).toBe(target);
      const res = await app.request(row.path, {
        method: row.method,
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status).not.toBe(413);
    });
  }

  it("test_dataset_item_at_post_parse_max_input_is_not_pre_rejected (review MEDIUM)", async () => {
    // A synthetic dataset item is valid post-parse with `input` up to 256K chars AND `output` up to 256K
    // chars (dataset-routes.ts MAX). The pre-parse cap MUST exceed that combined budget so a legitimate
    // max-size item is never shed with a 413 (D1: the cap moves earlier, it never SHRINKS the accepted
    // payload). Before the fix the 256 KiB pre-parse cap 413'd this valid body.
    const input = "x".repeat(256 * 1024);
    const output = "y".repeat(256 * 1024);
    const body = JSON.stringify({ input, output });
    expect(Buffer.byteLength(body)).toBeGreaterThan(256 * 1024); // would have 413'd on the old 256 KiB cap
    expect(Buffer.byteLength(body)).toBeLessThan(DATASET_ITEM_MAX_BYTES); // within the corrected ceiling
    const res = await app.request("/v1/datasets/d1/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).not.toBe(413); // the size guard does NOT fire (stub repo → 404, never a 413)
  });
});
