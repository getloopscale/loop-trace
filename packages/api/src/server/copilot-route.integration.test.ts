import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  RateLimiter,
  type Principal,
  type AuthVerifier,
} from "@looptrace/core";
import {
  ChatError,
  type ChatClient,
  type ChatMessage,
} from "@looptrace/core/provider";
import { createSpanRepository, migrateLatest } from "@looptrace/core/infra";
import type pg from "pg";

import { createApp } from "./app.js";
import {
  copilotAsksAnswered,
  copilotAsksRateLimited,
  copilotAsksUnavailable,
} from "./metrics.js";

const PG_URI = process.env["LOOPTRACE_PG_URI"];
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
          ro: principal(["observability:read"], "ws-x"),
          rw: principal(["observability:read", "observability:write"], "ws-x"),
          wo: principal(["observability:write"], "ws-x"), // write-only: no observability:read → 403
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

  it("test_ask_400_on_invalid_json_body", async () => {
    const app = makeApp({ chat: new FakeChat("hi") });
    await ingest(app, "t1", "s1");
    const res = await app.request("http://x/v1/traces/t1/ask", {
      method: "POST",
      headers: { authorization: "Bearer ro", "content-type": "application/json" },
      body: "{not json", // malformed
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("INVALID_BODY");
  });

  it("test_ask_increments_runtime_counters", async () => {
    // Wiring-triad pillar (c): the endpoint MUST be observable in production. Assert
    // the answered / rate-limited / unavailable counters actually fire (F-wire-1).
    const answered0 = copilotAsksAnswered.value;
    const limited0 = copilotAsksRateLimited.value;
    const unavail0 = copilotAsksUnavailable.value;
    // rpm=1 → first ask answered (+answered), second rate-limited (+limited).
    const app = makeApp({ chat: new FakeChat("ok"), rpm: 1, now: () => 5_000_000 });
    await ingest(app, "t1", "s1");
    expect((await ask(app, "t1", "ro", { question: "q1" })).status).toBe(200);
    expect((await ask(app, "t1", "ro", { question: "q2" })).status).toBe(429);
    // A provider failure (+unavailable) via a separate app with a failing chat.
    const failApp = makeApp({ chat: new FailingChat(), rpm: 100 });
    expect((await ask(failApp, "t1", "ro", { question: "q3" })).status).toBe(502);
    expect(copilotAsksAnswered.value).toBe(answered0 + 1);
    expect(copilotAsksRateLimited.value).toBe(limited0 + 1);
    expect(copilotAsksUnavailable.value).toBe(unavail0 + 1);
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

  // ── M83 answer feedback ─────────────────────────────────────────────────────
  const feedback = (app: ReturnType<typeof createApp>, traceId: string, token: string, body: unknown) =>
    app.request(`http://x/v1/traces/${traceId}/ask/feedback`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("M83 — feedback requires the WRITE scope (read-only → 403)", async () => {
    const app = makeApp({ chat: new FakeChat("hi") });
    await ingest(app, "t1", "s1");
    const res = await feedback(app, "t1", "ro", { turnId: "turn-1", label: "up" }); // read-only token
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("INSUFFICIENT_SCOPE");
  });

  it("M83 — records feedback with write scope AND is independent of the LLM (chat:null still works)", async () => {
    const app = makeApp({ chat: null }); // provider DOWN — feedback must still persist (risk-2)
    await ingest(app, "t1", "s1");
    const res = await feedback(app, "t1", "rw", { turnId: "turn-1", label: "up", question: "why?" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { label: string; turnId: string }).toMatchObject({ label: "up", turnId: "turn-1" });
  });

  it("M83 — a re-vote toggles the label (up→down), 200 both times", async () => {
    const app = makeApp({ chat: null });
    await ingest(app, "t1", "s1");
    expect((await feedback(app, "t1", "rw", { turnId: "turn-1", label: "up" })).status).toBe(200);
    const down = await feedback(app, "t1", "rw", { turnId: "turn-1", label: "down" });
    expect(down.status).toBe(200);
    expect(((await down.json()) as { label: string }).label).toBe("down");
  });

  it("M83 — 404 when the trace is absent (cannot attach feedback to a foreign/absent trace)", async () => {
    const app = makeApp({ chat: null });
    const res = await feedback(app, "ghost", "rw", { turnId: "turn-1", label: "up" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("TRACE_NOT_FOUND");
  });

  it("M83 — 400 on a bad label / missing turnId (typed, not a 500)", async () => {
    const app = makeApp({ chat: null });
    await ingest(app, "t1", "s1");
    const bad = await feedback(app, "t1", "rw", { turnId: "turn-1", label: "meh" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe("INVALID_FEEDBACK");
    const noTurn = await feedback(app, "t1", "rw", { label: "up" });
    expect(noTurn.status).toBe(400);
  });

  it("M83 — DELETE feedback retracts the vote (204), requires write scope + turnId", async () => {
    const app = makeApp({ chat: null });
    await ingest(app, "t1", "s1");
    await feedback(app, "t1", "rw", { turnId: "turn-1", label: "up" }); // record first
    const del = (token: string, qs: string) =>
      app.request(`http://x/v1/traces/t1/ask/feedback${qs}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    // read-only → 403
    expect((await del("ro", "?turnId=turn-1")).status).toBe(403);
    // missing turnId → 400
    expect((await del("rw", "")).status).toBe(400);
    // clear → 204, idempotent (a second clear is still 204)
    expect((await del("rw", "?turnId=turn-1")).status).toBe(204);
    expect((await del("rw", "?turnId=turn-1")).status).toBe(204);
  });
});
