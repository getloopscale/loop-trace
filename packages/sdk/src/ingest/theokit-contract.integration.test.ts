import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSpanRepository, migrateLatest, type SpanRepository } from "@usetheo/lens-core";
import { createApp } from "@usetheo/lens-api";
import type pg from "pg";

import { recordRun } from "./theokit.js";
import { LensReadClient } from "../read/client.js";
import type { SDKMessage } from "./sdk-message.js";
import type { RunResult } from "./sdk-message.js";

/**
 * M115 — the theokit-ingest ↔ engine contract proof (the "100% functional" evidence). A representative
 * `@theokit/sdk` run is translated by `recordRun` → OTLP → the REAL engine app (`createApp(repo)` +
 * Testcontainers Postgres), selected by `service.name=theokit-sdk` → the `theokit-sdk` adapter → read
 * back normalized via `LensReadClient`. In-process (`app.fetch`) is more hermetic than a socket while
 * exercising the exact ingest → adapter → repo → read path. Gated on THEOLENS_PG_URI.
 */
const PG_URI = process.env["THEOLENS_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

const RUN = "theokit-run-1";
const messages: SDKMessage[] = [
  { type: "system", subtype: "init", agent_id: "agent-x", run_id: RUN, model: "claude-opus-4-8", tools: ["Bash", "Read"] },
  { type: "user", agent_id: "agent-x", run_id: RUN, message: { role: "user", content: [{ type: "text", text: "List the files" }] } },
  { type: "thinking", agent_id: "agent-x", run_id: RUN, text: "I'll run ls", thinking_duration_ms: 120 },
  { type: "tool_call", agent_id: "agent-x", run_id: RUN, call_id: "call-1", name: "Bash", status: "completed", args: { command: "ls" }, result: "file.txt\n" },
  { type: "assistant", agent_id: "agent-x", run_id: RUN, message: { role: "assistant", content: [{ type: "text", text: "There is one file: file.txt" }] } },
  { type: "status", agent_id: "agent-x", run_id: RUN, status: "FINISHED" },
];
const runResult: RunResult = { usage: { inputTokens: 210, outputTokens: 15, cacheReadInputTokens: 40 }, cost: { totalUsd: 0.0031 } };

suite("theokit ingest ↔ engine contract (M115)", () => {
  let app: ReturnType<typeof createApp>;
  let repo: SpanRepository;
  let pool: pg.Pool;
  let engineFetch: typeof fetch;
  let client: LensReadClient;

  beforeAll(async () => {
    const created = createSpanRepository(PG_URI as string);
    repo = created.repo;
    pool = created.pool;
    await migrateLatest(pool);
    app = createApp(repo);
    engineFetch = (input, init) => app.fetch(new Request(typeof input === "string" ? input : input.toString(), init));
    client = new LensReadClient({ baseUrl: "http://engine.local", apiKey: "theo_live_contract", fetch: engineFetch });
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE spans, traces, sessions");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("test_theokit_run_ingests_and_reads_back_normalized", async () => {
    // Timestamps ~2 min in the past so the trace lands inside the read window.
    await recordRun(
      { messages, result: runResult },
      { baseUrl: "http://engine.local", apiKey: "theo_live_contract", fetch: engineFetch, startTimeMs: Date.now() - 120_000 },
    );

    // The run reads back as a trace with the normalized root fields.
    const { traces } = await client.listTraces({ limit: 50 });
    const t = traces.find((x) => x.traceId === RUN);
    expect(t, "the translated run should appear in the trace list").toBeTruthy();
    expect(t!.name).toBe("agent.run");
    expect(t!.model).toBe("claude-opus-4-8"); // model normalized by the default (via the theokit adapter)
    expect(t!.totalTokens).toBe(225); // 210 + 15 from RunResult.usage

    // The trace detail (span tree) carries the normalized input/output on the root span.
    const res = await engineFetch(`http://engine.local/v1/traces/${RUN}`, { headers: { authorization: "Bearer theo_live_contract" } });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as { inputValue?: string; outputValue?: string };
    expect(detail.inputValue).toBe("List the files");
    expect(detail.outputValue).toContain("file.txt");
  });

  it("test_theokit_trace_detail_has_the_tool_span", async () => {
    await recordRun(
      { messages, result: runResult },
      { baseUrl: "http://engine.local", apiKey: "theo_live_contract", fetch: engineFetch, startTimeMs: Date.now() - 120_000 },
    );
    // Read the full span tree via the trace-detail route and assert the Bash tool span is present + classified.
    const res = await engineFetch(`http://engine.local/v1/traces/${RUN}`, { headers: { authorization: "Bearer theo_live_contract" } });
    expect(res.status).toBe(200);
    const detail = (await res.json()) as { children?: Array<{ name?: string; toolName?: string }> };
    const names = JSON.stringify(detail);
    expect(names).toContain("Bash");
  });
});
