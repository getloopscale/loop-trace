import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type SpanRepository, type SDKMessage, type TheokitRunResult } from "@looptrace/core";
import { createSpanRepository, migrateLatest } from "@looptrace/core/infra";
import type pg from "pg";
import { createApp } from "./app.js";

/**
 * M116 — the native `POST /v1/runs` contract. A representative @theokit/sdk run posts as an SDKMessage
 * batch → the core mapper → the shared persist tail → reads back normalized. Negative cases prove the
 * fail-fast boundary. Per-tenant isolation is inherited from the SAME `repo.save(spans, ws)` path as
 * /v1/traces (proven exhaustively in `core/.../cross-tenant-isolation.integration.test.ts`); here the
 * engine runs single-tenant (default workspace) so the focus is the request/response contract.
 * Gated on LOOPTRACE_PG_URI.
 */
const PG_URI = process.env["LOOPTRACE_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

const RUN = "runs-endpoint-1";
const messages: SDKMessage[] = [
  { type: "system", subtype: "init", agent_id: "agent-y", run_id: RUN, model: { id: "claude-opus-4-8" }, tools: ["Bash"] },
  { type: "user", agent_id: "agent-y", run_id: RUN, message: { role: "user", content: [{ type: "text", text: "List the files" }] } },
  { type: "tool_call", agent_id: "agent-y", run_id: RUN, call_id: "c1", name: "Bash", status: "completed", args: { command: "ls" }, result: "file.txt\n" },
  { type: "assistant", agent_id: "agent-y", run_id: RUN, message: { role: "assistant", content: [{ type: "text", text: "One file: file.txt" }] } },
  { type: "status", agent_id: "agent-y", run_id: RUN, status: "FINISHED" },
];
const result: TheokitRunResult = { usage: { inputTokens: 300, outputTokens: 25 } };

suite("POST /v1/runs — native SDKMessage ingest (M116)", () => {
  let app: ReturnType<typeof createApp>;
  let repo: SpanRepository;
  let pool: pg.Pool;

  beforeAll(async () => {
    const created = createSpanRepository(PG_URI as string);
    repo = created.repo;
    pool = created.pool;
    await migrateLatest(pool);
    app = createApp(repo);
  });
  beforeEach(async () => { await pool.query("TRUNCATE spans, traces, sessions"); });
  afterAll(async () => { await pool.end(); });

  const postRun = (body: unknown, contentType = "application/json") =>
    app.request("/v1/runs", { method: "POST", headers: { "content-type": contentType }, body: typeof body === "string" ? body : JSON.stringify(body) });

  it("test_runs_endpoint_ingests_a_batch_and_reads_back", async () => {
    const res = await postRun({ messages, result });
    expect(res.status).toBe(200);
    expect((await res.json()).partialSuccess).toEqual({});

    // Read the trace back — normalized model + tokens; the Bash tool span present.
    const list = await (await app.request("/v1/traces?limit=50")).json();
    const t = (list.traces as Array<{ traceId: string; name: string; model?: string; totalTokens?: number }>).find((x) => x.traceId === RUN);
    expect(t, "the posted run should appear as a trace").toBeTruthy();
    expect(t!.model).toBe("claude-opus-4-8");
    expect(t!.totalTokens).toBe(325);
    const detail = await (await app.request(`/v1/traces/${RUN}`)).json();
    expect(JSON.stringify(detail)).toContain("Bash");
  });

  it("test_runs_endpoint_wrong_content_type_415", async () => {
    const res = await postRun(JSON.stringify({ messages }), "text/plain");
    expect(res.status).toBe(415);
  });

  it("test_runs_endpoint_malformed_json_typed_400", async () => {
    const res = await postRun("{ not json", "application/json");
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_BODY");
  });

  it("test_runs_endpoint_missing_messages_array_typed_400", async () => {
    const res = await postRun({ result });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("INVALID_BODY");
  });

  it("test_runs_endpoint_empty_batch_is_ok_no_spans", async () => {
    const res = await postRun({ messages: [] });
    expect(res.status).toBe(200); // an empty run is well-formed — nothing to persist, no error
  });

  it("test_runs_endpoint_out_of_range_startTimeMs_typed_400", async () => {
    // M117: a hostile out-of-range `startTimeMs` (negative epoch / absurd future) is rejected at the
    // boundary (fail-fast, error-handling.md §2) rather than minting absurd span timestamps. A
    // non-number is still tolerated (ignored) — only an in-band but out-of-range number is a 400.
    const neg = await postRun({ messages, result, startTimeMs: -1 });
    expect(neg.status).toBe(400);
    expect((await neg.json()).code).toBe("INVALID_BODY");
    const future = await postRun({ messages, result, startTimeMs: Date.now() + 7 * 86_400_000 });
    expect(future.status).toBe(400);
    // A non-number is ignored (backward-compatible), not a 400 — the run still ingests.
    const garbage = await postRun({ messages, result, startTimeMs: "nope" });
    expect(garbage.status).toBe(200);
  });
});
