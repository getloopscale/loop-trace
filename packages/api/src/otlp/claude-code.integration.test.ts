import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type SpanRepository,
} from "@usetheo/lens-core";
import { createSpanRepository, migrateLatest } from "@usetheo/lens-core/infra";
import type pg from "pg";

import { parseResourceSpans } from "./parse-resource-spans.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

/** A real-shaped Claude Code OTLP payload (2026-06-23 capture, sanitized). */
function claudePayload() {
  const common = (extra: object) => ({
    traceId: "cc11111111111111",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000005000000000",
    status: { code: 0 },
    ...extra,
  });
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "claude-code" } },
            { key: "service.version", value: { stringValue: "2.1.175" } },
          ],
        },
        scopeSpans: [
          {
            spans: [
              common({
                spanId: "cc00000000000001",
                name: "claude_code.interaction",
                attributes: [
                  { key: "session.id", value: { stringValue: "sess-cc-1" } },
                  { key: "span.type", value: { stringValue: "interaction" } },
                  { key: "user_prompt", value: { stringValue: "What is 2+2?" } },
                ],
              }),
              common({
                spanId: "cc00000000000002",
                parentSpanId: "cc00000000000001",
                name: "claude_code.llm_request",
                attributes: [
                  { key: "session.id", value: { stringValue: "sess-cc-1" } },
                  { key: "span.type", value: { stringValue: "llm_request" } },
                  { key: "gen_ai.request.model", value: { stringValue: "claude-opus-4-8[1m]" } },
                  { key: "gen_ai.system", value: { stringValue: "anthropic" } },
                  { key: "input_tokens", value: { intValue: "5380" } },
                  { key: "output_tokens", value: { intValue: "3" } },
                ],
              }),
            ],
          },
        ],
      },
    ],
  };
}

suite("Claude Code ingest (integration, M15)", () => {
  let repo: SpanRepository;
  let pool: pg.Pool;

  beforeAll(async () => {
    const created = createSpanRepository(PG_URI as string);
    repo = created.repo;
    pool = created.pool;
    await migrateLatest(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE spans, traces, sessions, replay_sessions, trace_tags");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("test_integration_claude_payload_roundtrips", async () => {
    await repo.save(parseResourceSpans(claudePayload()));

    const llm = await repo.getBySpanId("cc00000000000002");
    expect(llm?.model).toBe("claude-opus-4-8"); // suffix stripped by the claude adapter
    expect(llm?.provider).toBe("anthropic");
    expect(llm?.inputTokens).toBe(5380); // bare keys mapped
    expect(llm?.outputTokens).toBe(3);

    const root = await repo.getBySpanId("cc00000000000001");
    expect(root?.inputValue).toBe("What is 2+2?"); // user_prompt → input.value

    const cost = await repo.getTraceCost("cc11111111111111");
    expect(cost?.costUsd).toBeGreaterThan(0); // Claude prices added
    expect(cost?.totalTokens).toBe(5383);

    const detail = await repo.getSessionDetail("sess-cc-1");
    expect(detail?.traceCount).toBe(1); // grouped via session.id (M13)
    expect(detail?.costUsd).toBeGreaterThan(0);
  });

  it("test_integration_generic_payload_unaffected", async () => {
    const generic = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "my-app" } }] },
          scopeSpans: [
            {
              spans: [
                {
                  spanId: "gen0000000000001",
                  traceId: "gen1111111111111",
                  name: "chat",
                  startTimeUnixNano: "1700000000000000000",
                  endTimeUnixNano: "1700000001000000000",
                  attributes: [
                    { key: "gen_ai.request.model", value: { stringValue: "gpt-4o" } },
                    { key: "gen_ai.usage.input_tokens", value: { intValue: "100" } },
                    { key: "gen_ai.usage.output_tokens", value: { intValue: "50" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    await repo.save(parseResourceSpans(generic));
    const span = await repo.getBySpanId("gen0000000000001");
    expect(span?.model).toBe("gpt-4o");
    expect(span?.inputTokens).toBe(100); // gen_ai.usage via default adapter (no regression)
    expect(span?.outputTokens).toBe(50);
  });
});
