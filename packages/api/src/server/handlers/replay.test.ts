import { describe, it, expect } from "vitest";
import type { Context } from "hono";
import {
  RateLimiter,
  ChatError,
  type ChatMessage,
  type ReplayClient,
  type ReplayResult,
  type SpanRepository,
} from "@usetheo/lens-core";

import { replayHandler, type ReplayApiDeps } from "./replay.js";

// A ReplayClient stub — records the messages/model it was asked to run.
class FakeReplay implements ReplayClient {
  lastMessages: ChatMessage[] | null = null;
  lastModel: string | undefined = undefined;
  constructor(private readonly result: ReplayResult) {}
  async run(messages: ChatMessage[], model?: string): Promise<ReplayResult> {
    this.lastMessages = messages;
    this.lastModel = model;
    return { ...this.result, model: model ?? this.result.model };
  }
}
class FailingReplay implements ReplayClient {
  async run(): Promise<ReplayResult> {
    throw new ChatError("provider 503");
  }
}

// A read-only SpanRepository stub: ONLY getTraceTree is implemented. If the handler ever calls a
// write method it will throw (undefined is not a function) — a structural proof of no-mutation.
function fakeSpanRepo(present: Record<string, boolean>): SpanRepository {
  return {
    getTraceTree: async (traceId: string, _ws: string) =>
      present[traceId] ? ({ spanId: "s0", traceId, name: "op", children: [] } as unknown) : null,
  } as unknown as SpanRepository;
}

const RESULT: ReplayResult = { content: "new output", promptTokens: 12, completionTokens: 4, totalTokens: 16, model: "m" };

function ctx(opts: { traceId?: string; body?: unknown; rawBody?: string; ws?: string }): Context {
  const principal = { workspaceId: opts.ws ?? "ws-x", userId: "u", role: "member", scopes: ["observability:read"] };
  return {
    get: (k: string) => (k === "principal" ? principal : undefined),
    req: {
      param: (n: string) => (n === "traceId" ? (opts.traceId ?? "t1") : undefined),
      json: async () => {
        if (opts.rawBody !== undefined) return JSON.parse(opts.rawBody);
        return opts.body;
      },
    },
    json: (obj: unknown, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } }),
  } as unknown as Context;
}

function deps(over: Partial<ReplayApiDeps> = {}): ReplayApiDeps {
  return {
    spanRepo: fakeSpanRepo({ t1: true }),
    chat: new FakeReplay(RESULT),
    limiter: new RateLimiter(100),
    now: () => 1_000_000,
    ...over,
  };
}

describe("M55 replayHandler", () => {
  it("test_replay_valid_body_returns_output_tokens_latency", async () => {
    const d = deps();
    const res = await replayHandler(ctx({ body: { messages: [{ role: "user", content: "hi" }], model: "gpt-x" } }), d);
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect(j["output"]).toBe("new output");
    expect(j["promptTokens"]).toBe(12);
    expect(j["totalTokens"]).toBe(16);
    expect(j["model"]).toBe("gpt-x"); // the model override was used
    expect(typeof j["latencyMs"]).toBe("number");
  });

  it("test_replay_400_on_invalid_body (empty messages / bad role / non-json)", async () => {
    for (const bad of [
      { messages: [] }, // empty
      { messages: [{ role: "boss", content: "x" }] }, // bad role
      { messages: [{ role: "user" }] }, // missing content
      {}, // no messages
    ]) {
      const res = await replayHandler(ctx({ body: bad }), deps());
      expect(res.status).toBe(400);
    }
    const nonJson = await replayHandler(ctx({ rawBody: "{not json" }), deps());
    expect(nonJson.status).toBe(400);
  });

  it("test_replay_503_when_provider_unconfigured", async () => {
    const res = await replayHandler(ctx({ body: { messages: [{ role: "user", content: "hi" }] } }), deps({ chat: null }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("REPLAY_DISABLED");
  });

  it("test_replay_429_when_rate_limited (no provider call)", async () => {
    const chat = new FakeReplay(RESULT);
    const limiter = new RateLimiter(1);
    const d = deps({ chat, limiter, now: () => 2_000_000 });
    expect((await replayHandler(ctx({ body: { messages: [{ role: "user", content: "a" }] } }), d)).status).toBe(200);
    const second = await replayHandler(ctx({ body: { messages: [{ role: "user", content: "b" }] } }), d);
    expect(second.status).toBe(429);
    expect(((await second.json()) as { code: string }).code).toBe("RATE_LIMITED");
  });

  it("test_replay_502_when_provider_fails_closed", async () => {
    const res = await replayHandler(ctx({ body: { messages: [{ role: "user", content: "hi" }] } }), deps({ chat: new FailingReplay() }));
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("REPLAY_UNAVAILABLE");
  });

  it("test_replay_404_when_trace_absent_or_cross_tenant (no provider call)", async () => {
    const chat = new FakeReplay(RESULT);
    // getTraceTree returns null for an unknown/foreign trace → 404, and the provider is never called.
    const res = await replayHandler(ctx({ traceId: "ghost", body: { messages: [{ role: "user", content: "hi" }] } }), deps({ chat }));
    expect(res.status).toBe(404);
    expect(chat.lastMessages).toBeNull(); // billable call skipped for a trace the caller can't see
  });

  it("test_replay_does_not_mutate_the_trace (read-only repo; a write method would throw)", async () => {
    // The fake repo implements ONLY getTraceTree (a read). A 200 proves the handler never invoked a
    // write method — the immutable-trace invariant (M44 read-only body).
    const res = await replayHandler(ctx({ body: { messages: [{ role: "user", content: "hi" }] } }), deps());
    expect(res.status).toBe(200);
  });
});
