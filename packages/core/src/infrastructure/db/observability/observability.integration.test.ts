import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { Span } from "../../../domain/observability/span.js";
import { createPool, DrizzleSpanRepository } from "./drizzle-span-repository.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));
const suite = PG_URI ? describe : describe.skip;

function span(overrides: Partial<Span> & Pick<Span, "spanId" | "traceId">): Span {
  return {
    name: "op",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000100000000",
    ...overrides,
  };
}

suite("aggregateObservability (integration, M11)", () => {
  let pool: pg.Pool;
  let db: NodePgDatabase;
  let repo: DrizzleSpanRepository;

  beforeAll(async () => {
    pool = createPool(PG_URI as string);
    db = drizzle(pool);
    await migrate(db, { migrationsFolder: MIGRATIONS });
    repo = new DrizzleSpanRepository(db);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE spans, traces, sessions, replay_sessions");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("test_aggregate_observability_traffic_error_rate", async () => {
    await repo.save([span({ spanId: "e", traceId: "t-err", statusCode: "2" })]);
    await repo.save([span({ spanId: "a", traceId: "t-a", statusCode: "1" })]);
    await repo.save([span({ spanId: "b", traceId: "t-b", statusCode: "1" })]);
    await repo.save([span({ spanId: "c", traceId: "t-c", statusCode: "1" })]);
    const obs = await repo.aggregateObservability("24h");
    const totalTraces = obs.traffic.reduce((s, b) => s + b.traceCount, 0);
    const totalErrors = obs.traffic.reduce((s, b) => s + b.errorCount, 0);
    expect(totalTraces).toBe(4);
    expect(totalErrors).toBe(1);
    // Window-total error rate is deterministic regardless of how the 4 traces fall
    // across hour buckets (avoids an hour-boundary flake — F-test-5): 1/4 = 0.25.
    expect(Math.round((totalErrors / totalTraces) * 1000) / 1000).toBe(0.25);
    // Every per-bucket rate is a well-formed fraction in [0,1].
    for (const b of obs.traffic) {
      expect(b.errorRate).toBeGreaterThanOrEqual(0);
      expect(b.errorRate).toBeLessThanOrEqual(1);
    }
  });

  it("test_aggregate_observability_latency_percentiles_clamp_skew", async () => {
    // M53 / #74: latency is measured on `llm_request` SPANS now (not trace wall-clock). Three
    // llm_request spans in ONE bucket via a single statement-level now() (deterministic, no
    // hour-boundary flake): 10ms, 900ms, and a skewed end<start span. The skew span passes the
    // numeric-bound regex (both bounds are digits) so it is INCLUDED and clamped to 0ms —
    // durations = {0, 10, 900}.
    await pool.query(
      `INSERT INTO spans (span_id, trace_id, name, status_code, start_time_unix_nano, end_time_unix_nano, ingested_at) VALUES
        ('s-f','t-f','claude_code.llm_request','ok','1700000000000000000','1700000000010000000', now()),
        ('s-s','t-s','claude_code.llm_request','ok','1700000000000000000','1700000000900000000', now()),
        ('s-skew','t-skew','claude_code.llm_request','ok','1700000000900000000','1700000000000000000', now())`,
    );
    const obs = await repo.aggregateObservability("24h");
    expect(obs.latency).toHaveLength(1);
    const b = obs.latency[0]!;
    // Concrete clamp proof: median of {0,10,900} is 10. If the skew row had been
    // EXCLUDED (durations {10,900}) the median would be 455; if it had leaked a
    // negative, below 10. p50 ≈ 10 pins "clamped to 0 AND included".
    expect(b.p50Ms).toBeGreaterThan(0);
    expect(b.p50Ms).toBeLessThan(100);
    // p99 of {0,10,900} ≈ 882 — the 900ms tail is reflected, never negative.
    expect(b.p99Ms).toBeGreaterThan(800);
    expect(b.p99Ms).toBeGreaterThanOrEqual(b.p50Ms);
  });

  it("test_aggregate_observability_latency_excludes_non_numeric_bound_span", async () => {
    // M53 / #74: a normal 500ms llm_request span + a span with a NON-NUMERIC end bound inserted
    // directly (spans.end_time_unix_nano is NOT NULL, so garbage — not NULL — is the failure mode).
    // The numeric-bound regex excludes the garbage span so it can't drag the percentile to 0.
    await repo.save([
      span({ spanId: "n", traceId: "t-n", name: "claude_code.llm_request", startTimeUnixNano: "1700000000000000000", endTimeUnixNano: "1700000000500000000" }),
    ]);
    await pool.query(
      "INSERT INTO spans (span_id, trace_id, name, start_time_unix_nano, end_time_unix_nano, ingested_at) VALUES ('bad','t-bad','claude_code.llm_request','1700000000000000000','notanumber', now())",
    );
    const obs = await repo.aggregateObservability("24h");
    // The garbage-bound span is excluded (EC-1): p50 reflects the 500ms span, not a spurious 0.
    const p50s = obs.latency.map((b) => b.p50Ms);
    expect(p50s.some((p) => p >= 400)).toBe(true); // ~500ms, not dragged to 0
  });

  it("test_latency_reflects_llm_request_spans_not_interaction_wall_clock", async () => {
    // M53 / theo-lens#74: an interaction trace's wall-clock is minutes (human thinking/typing) — that
    // is NOT request latency. The metric must reflect the child `llm_request` spans (real model-call
    // latency), so a 40-min interaction with a 5s request yields a p95 of ~5s, not ~40min.
    await repo.save([
      span({
        spanId: "root",
        traceId: "ti",
        name: "claude_code.interaction",
        startTimeUnixNano: "1700000000000000000",
        endTimeUnixNano: "1700002400000000000", // +2400s = 40 min
      }),
      span({
        spanId: "req",
        traceId: "ti",
        parentSpanId: "root",
        name: "claude_code.llm_request",
        model: "claude-opus-4-8",
        startTimeUnixNano: "1700000000000000000",
        endTimeUnixNano: "1700000005000000000", // +5s
      }),
    ]);
    const obs = await repo.aggregateObservability("24h");
    const p95 = Math.max(0, ...obs.latency.map((b) => b.p95Ms));
    expect(p95).toBeLessThan(60_000); // < 1 min — NOT the 40-min interaction (2,400,000 ms)
    expect(p95).toBeGreaterThan(4_000); // ~5 s request latency
  });

  it("test_aggregate_observability_tokens_and_cost_by_model", async () => {
    await repo.save([
      span({ spanId: "m1", traceId: "t-m1", model: "gpt-4o", inputTokens: 100, outputTokens: 50 }),
    ]);
    await repo.save([
      span({ spanId: "m2", traceId: "t-m2", model: "claude-3-5-sonnet", inputTokens: 1000, outputTokens: 500 }),
    ]);
    // a tool span with NO model must be excluded (EC-4)
    await repo.save([
      span({ spanId: "tool", traceId: "t-tool", toolName: "search", inputTokens: 0, outputTokens: 0 }),
    ]);
    const obs = await repo.aggregateObservability("24h");
    const models = obs.tokensByModel.map((m) => m.model);
    // Multi-model bucket (Coverage Matrix #1): BOTH models surface as distinct rows
    // — a GROUP-BY regression collapsing models or a top-1 cap would fail here.
    expect(models).toContain("gpt-4o");
    expect(models).toContain("claude-3-5-sonnet");
    expect(models).not.toContain(null);
    expect(new Set(models).size).toBe(2);
    const gpt = obs.tokensByModel.find((m) => m.model === "gpt-4o")!;
    expect(gpt.totalTokens).toBe(150);
    expect(gpt.costUsd).toBeGreaterThan(0);
    const claude = obs.tokensByModel.find((m) => m.model === "claude-3-5-sonnet")!;
    expect(claude.totalTokens).toBe(1500);
    // claude-3-5-sonnet is priced ($3/$15 per 1M) → 1000·3/1e6 + 500·15/1e6 = 0.0105
    // → round3 0.011 (distinct from an unpriced model, which would be $0).
    expect(claude.costUsd).toBeGreaterThan(0);
  });

  it("test_aggregate_observability_tokens_by_model_excludes_null_model", async () => {
    await repo.save([span({ spanId: "tool", traceId: "t-only-tool", toolName: "search" })]);
    const obs = await repo.aggregateObservability("24h");
    expect(obs.tokensByModel).toEqual([]); // no model-bearing spans
  });

  it("test_aggregate_observability_empty_range_returns_empty_series", async () => {
    const obs = await repo.aggregateObservability("1h");
    expect(obs.traffic).toEqual([]);
    expect(obs.latency).toEqual([]);
    expect(obs.tokensByModel).toEqual([]);
    expect(obs.range).toBe("1h");
  });

  // theo-lens#136 — a janela de 30 dias derrubava a tela inteira com 500 INTERNAL, e a causa era de
  // TIPO, não de volume: `sum()` sobre uma coluna int4 devolve int8, e o `::int` a espremia de volta
  // em 4 bytes. Cada linha cabia; a soma do balde não. O Postgres levanta `22003 integer out of
  // range` (int8.c, rotina int84) e o operador via "the lens service is not reachable".
  //
  // O fixture usa DUAS linhas que individualmente cabem em int4 — é o ponto: um teste com uma linha
  // gigante testaria a coluna, não a SOMA, e passaria mesmo com o defeito de volta.
  it("test_aggregate_observability_token_sum_above_int4_does_not_overflow", async () => {
    const INT4_MAX = 2_147_483_647;
    const metade = Math.floor(INT4_MAX / 2) + 1_000;
    expect(metade).toBeLessThan(INT4_MAX); // cada linha cabe…
    expect(metade * 2).toBeGreaterThan(INT4_MAX); // …e a soma não

    // `cache_read_tokens` é o que estourou em produção (o Claude Code relê o cache a cada turno);
    // `input_tokens` entra junto porque é ele que a resposta EXPÕE, e sem um campo exposto não há
    // como afirmar valor exato — só "não explodiu", que é fraco demais.
    await repo.save([
      span({
        spanId: "ov1",
        traceId: "t-ov1",
        model: "claude-sonnet",
        inputTokens: metade,
        cacheReadTokens: metade,
      }),
      span({
        spanId: "ov2",
        traceId: "t-ov2",
        model: "claude-sonnet",
        inputTokens: metade,
        cacheReadTokens: metade,
      }),
    ]);

    const obs = await repo.aggregateObservability("30d");
    const soma = obs.tokensByModel.reduce((s, b) => s + b.totalTokens, 0);
    // Valor EXATO, não apenas "não explodiu": uma coerção quebrada devolveria NaN ou 0, e ambas
    // passariam por um `toBeGreaterThan`.
    expect(soma).toBe(metade * 2);
  });
});
