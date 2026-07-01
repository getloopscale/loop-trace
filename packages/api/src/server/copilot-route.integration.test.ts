import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createSpanRepository,
  migrateLatest,
  RateLimiter,
  ChatError,
  type ChatClient,
  type ChatMessage,
  type Principal,
  type AuthVerifier,
} from "@usetheo/lens-core";
import type pg from "pg";

import { createApp } from "./app.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

function verifierFor(map: Record<string, Principal>): AuthVerifier {
  return {
    resolvePrincipal: async (t) => map[t] ?? null,
    verify: async (t) => map[t] !== undefined,
  };
}
const principal = (scopes: string[], workspaceId = "ws-x"): Principal => ({
  workspaceId,
  userId: "u",
  role: "member",
  scopes,
});

/** A fake chat client: returns a canned answer, echoing the prompt size for assertions. */
class FakeChat implements ChatClient {
  lastMessages: ChatMessage[] | null = null;
  constructor(private readonly answer: string) {}
  async ask(messages: ChatMessage[]): Promise<string> {
    this.lastMessages = messages;
    return this.answer;
  }
}
/** A chat client that always fails closed (provider 500 / network error). */
class FailingChat implements ChatClient {
  async ask(): Promise<string> {
    throw new ChatError("upstream 503");
  }
}

const OTLP = (traceId: string, spanId: string) =>
  JSON.stringify({
    resourceSpans: [
      {
        scopeSpans: [
          {
            spans: [
              {
                spanId,
                traceId,
                name: "op",
                startTimeUnixNano: "1700000000000000000",
                endTimeUnixNano: "1700000000100000000",
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  });

suite("M33 copilot route (integration)", () => {
  let pool: pg.Pool;
  let repo: ReturnType<typeof createSpanRepository>["repo"];

  beforeAll(async () => {
    const made = createSpanRepository(PG_URI as string);
    pool = made.pool;
    repo = made.repo;
    await migrateLatest(pool);
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE spans, traces, sessions");
  });
  afterAll(async () => {
    await pool.end();
  });

  // Build an app with a configurable copilot wiring. `chat: null` => 503 (disabled);
  // `rpm`/`now` drive the rate-limiter (D3). A shared verifier mints ro/rw/wo tokens.
  function makeApp(opts: {
    chat: ChatClient | null;
    rpm?: number;
    now?: () => number;
  }): ReturnType<typeof createApp> {
    return createApp(
      repo,
      undefined,
      {
        verifier: verifierFor({
          ro: principal(["lens:read"], "ws-x"),
          rw: principal(["lens:read", "lens:write"], "ws-x"),
          wo: principal(["lens:write"], "ws-x"), // write-only: no lens:read → 403
        }),
        requireCredential: true,
      },
      undefined,
      {
        spanRepo: repo,
        chat: opts.chat,
        limiter: new RateLimiter(opts.rpm ?? 100),
        ...(opts.now ? { now: opts.now } : {}),
      },
    );
  }

  const ask = (
    app: ReturnType<typeof createApp>,
    traceId: string,
    token: string,
    body: unknown,
  ) =>
    app.request(`http://x/v1/traces/${traceId}/ask`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const ingest = (app: ReturnType<typeof createApp>, traceId: string, spanId: string) =>
    app.request("http://x/v1/traces", {
      method: "POST",
      headers: { authorization: "Bearer rw", "content-type": "application/json" },
      body: OTLP(traceId, spanId),
    });

  it("test_ask_requires_read_scope", async () => {
    const app = makeApp({ chat: new FakeChat("hi") });
    await ingest(app, "t1", "s1");
    const res = await ask(app, "t1", "wo", { question: "why?" }); // write-only token
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("INSUFFICIENT_SCOPE");
  });

  it("test_ask_returns_answer_with_read_scope_and_mock_chat", async () => {
    const chat = new FakeChat("Because the span errored.");
    const app = makeApp({ chat });
    await ingest(app, "t1", "s1");
    const res = await ask(app, "t1", "ro", { spanId: "s1", question: "why did it fail?" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { answer: string }).answer).toBe("Because the span errored.");
    // The prompt was grounded (system + user-with-context), never the raw question alone.
    expect(chat.lastMessages).toHaveLength(2);
    expect(chat.lastMessages?.[0]?.role).toBe("system");
  });

  it("test_ask_404_when_trace_absent", async () => {
    const app = makeApp({ chat: new FakeChat("hi") });
    const res = await ask(app, "nope", "ro", { question: "why?" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("TRACE_NOT_FOUND");
  });

  it("test_ask_503_when_copilot_disabled", async () => {
    const app = makeApp({ chat: null }); // no provider configured → fail-closed
    await ingest(app, "t1", "s1");
    const res = await ask(app, "t1", "ro", { question: "why?" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("COPILOT_DISABLED");
  });

  it("test_ask_429_when_rate_limited_then_recovers_next_window", async () => {
    // rpm=1, fixed window of 60s. First call passes; second (same window) is 429;
    // a call in the next window passes again (EC-3 window-boundary assertion).
    let clock = 1_000_000;
    const app = makeApp({ chat: new FakeChat("ok"), rpm: 1, now: () => clock });
    await ingest(app, "t1", "s1");
    const r1 = await ask(app, "t1", "ro", { question: "q1" });
    expect(r1.status).toBe(200);
    const r2 = await ask(app, "t1", "ro", { question: "q2" });
    expect(r2.status).toBe(429);
    expect(((await r2.json()) as { code: string }).code).toBe("RATE_LIMITED");
    clock += 60_000; // advance past the window boundary
    const r3 = await ask(app, "t1", "ro", { question: "q3" });
    expect(r3.status).toBe(200);
  });

  it("test_ask_502_when_chat_fails_closed", async () => {
    const app = makeApp({ chat: new FailingChat() });
    await ingest(app, "t1", "s1");
    const res = await ask(app, "t1", "ro", { question: "why?" });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("COPILOT_UNAVAILABLE");
  });

  it("test_ask_400_when_question_empty", async () => {
    const app = makeApp({ chat: new FakeChat("hi") });
    await ingest(app, "t1", "s1");
    const res = await ask(app, "t1", "ro", { question: "   " }); // EC-1 empty after trim
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_QUESTION");
  });

  it("test_ask_400_when_question_oversized", async () => {
    const app = makeApp({ chat: new FakeChat("hi") });
    await ingest(app, "t1", "s1");
    const huge = "x".repeat(4 * 1024 + 1); // EC-1 > 4 KiB
    const res = await ask(app, "t1", "ro", { question: huge });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_QUESTION");
  });

  it("test_ask_404_when_span_not_in_trace", async () => {
    const app = makeApp({ chat: new FakeChat("hi") });
    await ingest(app, "t1", "s1");
    const res = await ask(app, "t1", "ro", { spanId: "ghost", question: "why?" }); // EC-2
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("SPAN_NOT_FOUND");
  });

  it("test_ask_caps_oversized_answer", async () => {
    // EC-6: a runaway model answer is capped to 32 KiB before it reaches the client.
    const app = makeApp({ chat: new FakeChat("y".repeat(40 * 1024)) });
    await ingest(app, "t1", "s1");
    const res = await ask(app, "t1", "ro", { question: "why?" });
    expect(res.status).toBe(200);
    const { answer } = (await res.json()) as { answer: string };
    expect(Buffer.byteLength(answer, "utf8")).toBe(32 * 1024);
  });
});
