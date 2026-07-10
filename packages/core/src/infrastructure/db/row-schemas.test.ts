import { describe, expect, it } from "vitest";

import { rowsAs } from "../../domain/sql-rows.js";
import { sessionAggRowSchema, sessionListRowSchema } from "./session-repository.js";
import {
  agentRowSchema,
  latencyRowSchema,
  tokensByModelRowSchema,
  trafficRowSchema,
} from "./aggregate-repository.js";

/**
 * M100 (B-L1) — a negative test per raw SQL→DTO row schema: a renamed/omitted SELECT alias must throw
 * loudly at the `rowsAs` boundary (not shape a silent `undefined` downstream). Each case feeds a row
 * whose FIRST field is dropped and asserts the contextful error names that field.
 */
const cases: Array<{ ctx: string; schema: Parameters<typeof rowsAs>[1]; validRow: Record<string, unknown>; dropped: string }> = [
  {
    ctx: "listSessions",
    schema: sessionListRowSchema,
    validRow: { sessionId: "s", firstSeenAt: new Date(), lastSeenAt: new Date(), traceCount: 1, costUsd: 0, totalTokens: 0, errorCount: 0, evaluationsCount: 0, firstMessageRaw: null },
    dropped: "sessionId",
  },
  {
    ctx: "getSessionDetail",
    schema: sessionAggRowSchema,
    validRow: { traceCount: 1, costUsd: null, totalTokens: null, errorCount: 0, p50: null, p95: null },
    dropped: "traceCount",
  },
  {
    ctx: "observability.traffic",
    schema: trafficRowSchema,
    validRow: { bucket: new Date(), traceCount: 1, errorCount: 0 },
    dropped: "traceCount",
  },
  {
    ctx: "observability.latency",
    schema: latencyRowSchema,
    validRow: { bucket: new Date(), p50: 1, p75: 1, p95: 1, p99: 1 },
    dropped: "p50",
  },
  {
    ctx: "observability.tokensByModel",
    schema: tokensByModelRowSchema,
    validRow: { bucket: new Date(), model: "gpt", inputTokens: 1, outputTokens: 1 },
    dropped: "inputTokens",
  },
  {
    ctx: "aggregateAgents",
    schema: agentRowSchema,
    validRow: { name: "a", first_seen: new Date(), last_seen: new Date(), run_count: 1, versions: null, system_prompt: null, tools: null },
    dropped: "run_count",
  },
];

describe("M100 raw row schemas — loud failure on a renamed/omitted column", () => {
  it.each(cases)("$ctx accepts a valid row but throws when '$dropped' is renamed away", ({ ctx, schema, validRow, dropped }) => {
    // valid row passes
    expect(() => rowsAs({ rows: [validRow] }, schema, ctx)).not.toThrow();
    // a row missing the column (a renamed SELECT alias) throws loudly, naming the query + field
    const broken = { ...validRow };
    delete broken[dropped];
    expect(() => rowsAs({ rows: [broken] }, schema, ctx)).toThrowError(
      new RegExp(`rowsAs\\(${ctx.replace(/\./g, "\\.")}\\): row 0 failed SQL→DTO validation at "${dropped}"`),
    );
  });
});
