/**
 * M99 (audit B-M1) — the AggregateRepository role (windowed time-series, cost/tool/north-star/
 * observability/evaluator/score aggregates + M92 facet discovery + M32 agents catalog), extracted
 * from the god-adapter into its own file. Pure functions over the shared Drizzle `db` handle (+
 * `priceTable` for the cost-shaped observability). Shares the SQL fragments from `repo-shared`.
 * Behavior-preserving: the SQL/shaping moved verbatim; the aggregate integration tests are the proof.
 */
import {      sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { DEFAULT_WORKSPACE_ID } from "../../../domain/principal.js";
import { isoTimestamp } from "../../../domain/observability/session.js";
import { round3, ERROR_STATUS_CODES } from "../../../domain/observability/tool-stats.js";
import type { ToolStatsResponse } from "../../../domain/observability/tool-stats.js";
import { type PriceTable } from "../../../domain/observability/pricing.js";
import type { CostByPeriodResponse, CostPeriod } from "../../../domain/observability/cost.js";
import type { PromptUsageRow } from "../../../domain/observability/prompt-usage.js";
import { shapeNorthStarBuckets, bucketRowSchema, type NorthStarResponse } from "../../../domain/observability/north-star.js";
import {
  shapeObservability,
  RANGE_BUCKETS,
  type RawObservability,
  type ObservabilityRange,
  type ObservabilityResponse } from "../../../domain/observability/observability.js";
import type { EvaluatorSummary, ScoreBucket } from "../../../domain/evaluation/evaluation.js";
import type { SpanAttributeKey, SpanAttributeValue } from "../../../domain/observability/span-facets.js";
import { shapeAgent, type Agent, type RawAgent } from "../../../domain/observability/agent-catalog.js";
import {   replaySessions } from "../schema.js";
import {
    LATENCY_MS_EXPR,
  DERIVED_AGENT_NAME_SQL } from "../repo-shared.js";
import { rowsAs } from "../../../domain/sql-rows.js";


const bucketVal = z.union([z.date(), z.string()]);
/** M100 (B-L1) — raw observability rows; a renamed SELECT alias fails loudly at the rowsAs boundary. */
export const trafficRowSchema = z.object({ bucket: bucketVal, traceCount: z.number(), errorCount: z.number() });
export const latencyRowSchema = z.object({
  bucket: bucketVal,
  p50: z.number().nullable(),
  p75: z.number().nullable(),
  p95: z.number().nullable(),
  p99: z.number().nullable(),
});
export const tokensByModelRowSchema = z.object({
  bucket: bucketVal,
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  // M52 / theo-lens#71 Finding 1 — cache tokens are billable and must feed the cost trend.
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
});
/** M100 (B-L1) — the raw agents-catalog row. */
export const agentRowSchema = z.object({
  name: z.string(),
  first_seen: z.union([z.date(), z.string()]),
  last_seen: z.union([z.date(), z.string()]),
  run_count: z.number(),
  versions: z.array(z.string()).nullable(),
  system_prompt: z.string().nullable(),
  tools: z.array(z.string()).nullable(),
});

export async function aggregateCostByPeriod(
  db: NodePgDatabase,
  period: CostPeriod,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<CostByPeriodResponse> {
  // `period` is whitelisted to the union literal (no raw interpolation) AND
  // bound as a parameter; date_trunc buckets the precomputed cost. The 90-day
  // `updated_at` window bounds the scan and lets `traces_updated_at_idx` serve a
  // range scan (risk #2) instead of a full-table aggregate.
  const trunc = period === "week" ? "week" : "day";
  const res = await db.execute(sql`
    SELECT date_trunc(${trunc}, updated_at) AS bucket,
           coalesce(sum(cost_usd), 0)::double precision AS cost,
           coalesce(sum(total_tokens), 0)::double precision AS tokens,
           count(*)::int AS n
    FROM traces
    WHERE updated_at >= now() - interval '90 days' AND workspace_id = ${workspaceId}
    GROUP BY bucket
    ORDER BY bucket DESC
  `);
  const buckets = (
    res.rows as { bucket: Date | string; cost: number; tokens: number; n: number }[]
  ).map((r) => ({
    periodStart:
      r.bucket instanceof Date ? r.bucket.toISOString() : String(r.bucket),
    costUsd: r.cost,
    totalTokens: r.tokens,
    traceCount: r.n }));
  return { period, buckets };
}

/**
 * M15 (theo-promptly) — uso por revisão de um prompt, numa janela.
 *
 * NÃO é um self-join sobre `spans`. A tabela `traces` já mantém `total_tokens` e
 * `cost_usd` por trace (PK composta `(workspace_id, trace_id)`), então o agregado
 * junta `spans` a `traces` pela chave primária desta — o mesmo motivo do #73: o
 * custo autoritativo vive no trace, e re-somar por span devolve zero quando o
 * custo está no pai.
 *
 * `workspace_id` entra nos DOIS lados do join de propósito. O schema PREVÊ o mesmo
 * `trace_id` em dois inquilinos (M22 / review F-sec-3); omiti-lo num lado
 * reintroduz um vazamento cross-tenant já corrigido uma vez.
 *
 * Três detalhes que a leitura de `attributes` impõe:
 *
 * - `prompt.id` carrega o NOME do prompt (nomenclatura herdada), e é por ele que
 *   se filtra — daí o índice parcial `spans_prompt_resolve_idx` ser sobre ele.
 * - `attributes->>` devolve TEXTO: sem `::int`, a v10 ordena antes da v9.
 * - `revision = -1` é o sentinela de "não encontrei o prompt" que o decorator
 *   grava (`p?.version ?? -1`). Agrupar por ele criaria uma linha de uso fantasma.
 */
export async function aggregatePromptUsage(
  db: NodePgDatabase,
  promptName: string,
  windowDays: number,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<PromptUsageRow[]> {
  const res = await db.execute(sql`
    SELECT (s.attributes->>'prompt.revision')::int          AS revision,
           count(*)::int                                    AS resolutions,
           coalesce(sum(t.total_tokens), 0)::int            AS tokens,
           sum(t.cost_usd)::double precision                AS cost,
           -- Mediana da RESOLUÇÃO, não do trace: o trace inclui a chamada ao modelo, que é
           -- ordens de grandeza mais lenta e responderia outra pergunta.
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY greatest(0, (s.end_time_unix_nano::numeric - s.start_time_unix_nano::numeric) / 1e6)
           )::double precision                              AS p50_latency_ms
      FROM spans s
      LEFT JOIN traces t
             ON t.workspace_id = s.workspace_id
            AND t.trace_id     = s.trace_id
     WHERE s.workspace_id = ${workspaceId}
       AND s.name = 'prompt.resolve'
       AND s.attributes->>'prompt.id' = ${promptName}
       AND s.attributes->>'prompt.revision' <> '-1'
       AND s.ingested_at >= now() - make_interval(days => ${windowDays})
     GROUP BY 1
     ORDER BY 1 DESC
  `);
  return (
    res.rows as {
      revision: number;
      resolutions: number;
      tokens: number;
      cost: number | null;
      p50_latency_ms: number | null;
    }[]
  ).map((r) => ({
    revision: Number(r.revision),
    resolutions: Number(r.resolutions),
    totalTokens: Number(r.tokens),
    costUsd: r.cost === null ? null : Number(r.cost),
    p50LatencyMs: r.p50_latency_ms === null ? null : Number(r.p50_latency_ms),
  }));
}

export async function aggregateToolStats(
  db: NodePgDatabase,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<ToolStatsResponse> {
  // Per-tool stats over execute_tool spans in a 90-day window, GROUP BY the typed
  // indexed tool_name, ORDER BY call count DESC + top-100 (bounds high cardinality,
  // risk #2). p50/p95 via engine-side percentile_cont over latency-in-ms; the pure
  // computeToolStats is the unit-tested contract this is cross-checked against (D1).
  // Error tokens kept in sync with the UI status mapping (review F-st-1); latency
  // clamped to >= 0 for clock skew (review F-st-2). Tool spans are identified by
  // tool_name IS NOT NULL — the SDK only sets gen_ai.tool.name on execute_tool spans.
  const errorList = ERROR_STATUS_CODES.map((c) => `'${c}'`).join(", ");
  const res = await db.execute(sql`
    SELECT tool_name,
           count(*)::int AS call_count,
           count(*) FILTER (WHERE status_code IN (${sql.raw(errorList)}))::int AS error_count,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY ${sql.raw(LATENCY_MS_EXPR)}
           )::double precision AS p50,
           percentile_cont(0.95) WITHIN GROUP (
             ORDER BY ${sql.raw(LATENCY_MS_EXPR)}
           )::double precision AS p95
    FROM spans
    WHERE tool_name IS NOT NULL AND ingested_at >= now() - interval '90 days' AND workspace_id = ${workspaceId}
    GROUP BY tool_name
    ORDER BY call_count DESC
    LIMIT 100
  `);
  const tools = (
    res.rows as {
      tool_name: string;
      call_count: number;
      error_count: number;
      p50: number;
      p95: number;
    }[]
  ).map((r) => ({
    toolName: r.tool_name,
    callCount: r.call_count,
    errorCount: r.error_count,
    errorRate: r.call_count === 0 ? 0 : round3(r.error_count / r.call_count),
    p50Ms: round3(r.p50),
    p95Ms: round3(r.p95) }));
  return { tools };
}

export async function recordReplaySession(
  db: NodePgDatabase,
  traceId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<void> {
  // One row per replay opened in the UI — the sole data source for the
  // "replay sessions per week" north-star (replay is otherwise client-only).
  await db.insert(replaySessions).values({ traceId, workspaceId });
}

export async function aggregateNorthStar(
  db: NodePgDatabase,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<NorthStarResponse> {
  // North-star (M8, D2): traces ingested per day (real telemetry arriving) +
  // replay sessions opened per week (active debugging). Both via date_trunc
  // over an indexed timestamp + a bounded recent window (reuses the M5 cost
  // aggregation pattern). traces/day uses COUNT(DISTINCT trace_id) so a
  // multi-span trace counts once (EC-1 of the cost work, applied here).
  //
  // This is a DIRECTIONAL trend signal, not a billing figure: date_trunc
  // buckets in the server TimeZone (not pinned to UTC, consistent with
  // aggregateCostByPeriod), and a trace whose spans straddle a day boundary
  // can appear in two day buckets. Both are acceptable for a usage trend; the
  // integration test sums over the window rather than asserting a bucket label.
  const tracesRes = await db.execute(sql`
    SELECT date_trunc('day', ingested_at) AS bucket,
           count(DISTINCT trace_id)::int AS count
    FROM spans
    WHERE ingested_at >= now() - interval '30 days' AND workspace_id = ${workspaceId}
    GROUP BY bucket
    ORDER BY bucket DESC
  `);
  const sessionsRes = await db.execute(sql`
    SELECT date_trunc('week', opened_at) AS bucket,
           count(*)::int AS count
    FROM replay_sessions
    WHERE opened_at >= now() - interval '12 weeks' AND workspace_id = ${workspaceId}
    GROUP BY bucket
    ORDER BY bucket DESC
  `);
  return {
    // M97 (B-L1) — validate the raw bucket rows at the SQL→DTO boundary; a renamed
    // `date_trunc`/`count` alias now throws loudly here instead of shaping `undefined`.
    tracesPerDay: shapeNorthStarBuckets(rowsAs(tracesRes, bucketRowSchema, "northStar.tracesPerDay")),
    replaySessionsPerWeek: shapeNorthStarBuckets(
      rowsAs(sessionsRes, bucketRowSchema, "northStar.replaySessionsPerWeek"),
    ) };
}

export async function aggregateObservability(
  db: NodePgDatabase,
  priceTable: PriceTable,
  range: ObservabilityRange,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<ObservabilityResponse> {
  // M11: three windowed time-series, reusing the M5 date_trunc bucket + the M6
  // percentile_cont/error-FILTER templates. `trunc`/`interval` come from the
  // fixed RANGE_BUCKETS whitelist (sql.raw of a hardcoded constant, never the
  // request string). Cost-by-model is shaped from tokens × price (D2), not SQL.
  const { interval, trunc } = RANGE_BUCKETS[range];

  // Traffic: trace count + error count per bucket. traces.status_code is the M9
  // recompute ('error' when any span errored, else 'ok') — NOT a raw OTLP code,
  // so the FILTER matches the literal 'error', not ERROR_STATUS_CODES.
  const trafficRes = await db.execute(sql`
    SELECT date_trunc(${trunc}, updated_at) AS bucket,
           count(*)::int AS "traceCount",
           count(*) FILTER (WHERE status_code = 'error')::int AS "errorCount"
    FROM traces
    WHERE updated_at >= now() - ${sql.raw(`interval '${interval}'`)} AND workspace_id = ${workspaceId}
    GROUP BY bucket
    ORDER BY bucket ASC
  `);

  // Latency percentiles over clamped duration (ms). M53 / theo-lens#74: the metric measures REAL
  // model-call latency — the duration of `llm_request` spans — NOT a trace's wall-clock. An
  // `interaction` trace's wall-clock is minutes (human thinking/typing) and would poison the
  // percentile (a p95 of "32m"); `llm_request` spans are the actual request latency (seconds).
  // EC-1: only rows with BOTH bounds present AND numeric enter the percentile (a NULL/garbage bound
  // must not error the cast nor count as a spurious 0ms); skew clamped via greatest.
  const latencyRes = await db.execute(sql`
    SELECT date_trunc(${trunc}, ingested_at) AS bucket,
           percentile_cont(0.5)  WITHIN GROUP (ORDER BY ${sql.raw(LATENCY_MS_EXPR)})::double precision AS p50,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY ${sql.raw(LATENCY_MS_EXPR)})::double precision AS p75,
           percentile_cont(0.95) WITHIN GROUP (ORDER BY ${sql.raw(LATENCY_MS_EXPR)})::double precision AS p95,
           percentile_cont(0.99) WITHIN GROUP (ORDER BY ${sql.raw(LATENCY_MS_EXPR)})::double precision AS p99
    FROM spans
    WHERE ingested_at >= now() - ${sql.raw(`interval '${interval}'`)} AND workspace_id = ${workspaceId}
      -- exact substring match via position(): a LIKE %llm_request% would treat the literal _ as a
      -- single-char wildcard (also matching llm<x>request); position() is an exact substring test.
      AND position('llm_request' in name) > 0
      AND start_time_unix_nano ~ '^\\d+$' AND end_time_unix_nano ~ '^\\d+$'
    GROUP BY bucket
    ORDER BY bucket ASC
  `);

  // Tokens per (model, bucket) from spans (model lives on spans). EC-4: model
  // must be present. The range scan is index-backed by spans_ingested_at_idx (D4);
  // the GROUP BY model + non-selective IS NOT NULL are not served by spans_model_idx.
  const modelRes = await db.execute(sql`
    SELECT date_trunc(${trunc}, ingested_at) AS bucket,
           model,
           coalesce(sum(input_tokens), 0)::double precision AS "inputTokens",
           coalesce(sum(output_tokens), 0)::double precision AS "outputTokens",
           coalesce(sum(cache_read_tokens), 0)::double precision AS "cacheReadTokens",
           coalesce(sum(cache_creation_tokens), 0)::double precision AS "cacheCreationTokens"
    FROM spans
    WHERE ingested_at >= now() - ${sql.raw(`interval '${interval}'`)}
      AND model IS NOT NULL AND workspace_id = ${workspaceId}
    GROUP BY bucket, model
    ORDER BY bucket ASC
  `);

  const raw: RawObservability = {
    traffic: rowsAs(trafficRes, trafficRowSchema, "observability.traffic"),
    latency: rowsAs(latencyRes, latencyRowSchema, "observability.latency").map((r) => ({
      bucket: r.bucket,
      p50: r.p50 ?? 0,
      p75: r.p75 ?? 0,
      p95: r.p95 ?? 0,
      p99: r.p99 ?? 0,
    })),
    tokensByModel: rowsAs(modelRes, tokensByModelRowSchema, "observability.tokensByModel"),
  };
  return shapeObservability(raw, range, priceTable);
}

export async function aggregateEvaluators(
  db: NodePgDatabase,
  range: ObservabilityRange,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<EvaluatorSummary[]> {
  // M26: per-evaluator aggregate over the side-table, range-windowed by the
  // trace's updated_at (same RANGE_BUCKETS interval whitelist the M11 observability
  // uses — sql.raw of a hardcoded constant, never the request string).
  const { interval } = RANGE_BUCKETS[range];
  const window = sql.raw(`interval '${interval}'`);
  // count + avg score per evaluator (avg ignores NULL scores).
  const summaryRes = await db.execute(sql`
    SELECT se.name AS name,
           count(*)::int AS count,
           avg(se.score) AS "avgScore"
    FROM span_evaluations se
    JOIN traces t ON t.trace_id = se.trace_id AND t.workspace_id = se.workspace_id
    WHERE t.updated_at >= now() - ${window} AND se.workspace_id = ${workspaceId}
    GROUP BY se.name
    ORDER BY se.name ASC
  `);
  // label distribution per evaluator (NULL labels excluded).
  const labelRes = await db.execute(sql`
    SELECT se.name AS name, se.label AS label, count(*)::int AS count
    FROM span_evaluations se
    JOIN traces t ON t.trace_id = se.trace_id AND t.workspace_id = se.workspace_id
    WHERE t.updated_at >= now() - ${window} AND se.label IS NOT NULL AND se.workspace_id = ${workspaceId}
    GROUP BY se.name, se.label
  `);
  const labelsByName = new Map<string, Record<string, number>>();
  for (const r of labelRes.rows as { name: string; label: string; count: number }[]) {
    const m = labelsByName.get(r.name) ?? {};
    m[r.label] = Number(r.count);
    labelsByName.set(r.name, m);
  }
  return (summaryRes.rows as { name: string; count: number; avgScore: number | null }[]).map(
    (r) => ({
      name: r.name,
      count: Number(r.count),
      ...(r.avgScore != null ? { avgScore: Number(r.avgScore) } : {}),
      labels: labelsByName.get(r.name) ?? {} }),
  );
}

export async function aggregateScoresOverTime(
  db: NodePgDatabase,
  range: ObservabilityRange,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<ScoreBucket[]> {
  // M90: per-evaluator score aggregation bucketed over time — the M26 aggregate
  // (avg score + label distribution) with a `date_trunc` time axis added. The time
  // axis is the joined trace's updated_at (span_evaluations has no own timestamp),
  // windowed + truncated by the RANGE_BUCKETS whitelist (sql.raw of a hardcoded
  // constant, NEVER the request string). Only buckets with ≥ 1 sample are emitted —
  // an empty period is a gap, never a fabricated zero (M89 data-honesty).
  const { interval, trunc } = RANGE_BUCKETS[range];
  const window = sql.raw(`interval '${interval}'`);
  const bucket = sql.raw(`date_trunc('${trunc}', t.updated_at)`);
  // numeric: per (bucket, evaluator) — sample count + mean score (avg ignores NULL scores).
  const summaryRes = await db.execute(sql`
    SELECT ${bucket} AS bucket,
           se.name AS name,
           count(*)::int AS "sampleCount",
           avg(se.score) AS "avgScore"
    FROM span_evaluations se
    JOIN traces t ON t.trace_id = se.trace_id AND t.workspace_id = se.workspace_id
    WHERE t.updated_at >= now() - ${window} AND se.workspace_id = ${workspaceId}
    GROUP BY bucket, se.name
    ORDER BY bucket ASC, se.name ASC
  `);
  // label distribution per (bucket, evaluator) — NULL labels excluded.
  const labelRes = await db.execute(sql`
    SELECT ${bucket} AS bucket, se.name AS name, se.label AS label, count(*)::int AS count
    FROM span_evaluations se
    JOIN traces t ON t.trace_id = se.trace_id AND t.workspace_id = se.workspace_id
    WHERE t.updated_at >= now() - ${window} AND se.label IS NOT NULL AND se.workspace_id = ${workspaceId}
    GROUP BY bucket, se.name, se.label
  `);
  // key a (bucket, evaluator) cell by "isoBucket|name" so labels attach to the right bucket.
  const labelsByCell = new Map<string, Record<string, number>>();
  for (const r of labelRes.rows as { bucket: Date | string; name: string; label: string; count: number }[]) {
    const key = `${isoTimestamp(r.bucket)}|${r.name}`;
    const m = labelsByCell.get(key) ?? {};
    m[r.label] = Number(r.count);
    labelsByCell.set(key, m);
  }
  return (
    summaryRes.rows as { bucket: Date | string; name: string; sampleCount: number; avgScore: number | null }[]
  ).map((r) => {
    const periodStart = isoTimestamp(r.bucket);
    return {
      periodStart,
      name: r.name,
      sampleCount: Number(r.sampleCount),
      ...(r.avgScore != null ? { avgScore: round3(Number(r.avgScore)) } : {}),
      labels: labelsByCell.get(`${periodStart}|${r.name}`) ?? {} };
  });
}

// M92 — facet discovery over the spans.attributes jsonb bag. Capped: a recent 30-day window +
// top-N by frequency (the suggest control needs a hint, not an exhaustive index — ADR-3). Every
// query is workspace-scoped. The `key` in values-mode is a BOUND jsonb path (injection-safe).
const FACET_WINDOW = sql.raw("interval '30 days'");
const FACET_LIMIT = 50;

export async function discoverSpanAttributeKeys(
  db: NodePgDatabase,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<SpanAttributeKey[]> {
  const res = await db.execute(sql`
    SELECT key, count(*)::int AS count
    FROM (
      SELECT jsonb_object_keys(attributes) AS key
      FROM spans
      WHERE workspace_id = ${workspaceId}
        AND attributes IS NOT NULL
        AND ingested_at >= now() - ${FACET_WINDOW}
    ) k
    GROUP BY key
    ORDER BY count DESC, key ASC
    LIMIT ${FACET_LIMIT}
  `);
  return (res.rows as { key: string; count: number }[]).map((r) => ({
    key: r.key,
    count: Number(r.count) }));
}

export async function discoverSpanAttributeValues(
  db: NodePgDatabase,
  key: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<SpanAttributeValue[]> {
  // The KEY is bound as a jsonb path operand (data, never SQL) — same injection-safety as `attr:`.
  const res = await db.execute(sql`
    SELECT value, count(*)::int AS count
    FROM (
      SELECT attributes->>${key} AS value
      FROM spans
      WHERE workspace_id = ${workspaceId}
        AND ingested_at >= now() - ${FACET_WINDOW}
    ) v
    WHERE value IS NOT NULL
    GROUP BY value
    ORDER BY count DESC, value ASC
    LIMIT ${FACET_LIMIT}
  `);
  return (res.rows as { value: string; count: number }[]).map((r) => ({
    value: r.value,
    count: Number(r.count) }));
}

export async function aggregateAgents(
  db: NodePgDatabase,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<Agent[]> {
  // M32 (D1/D2) + M85 (ADR 0002): derive the catalog by the DERIVED agent name — the explicit
  // `agent.name` attribute OR the conservative structural rule (a `claude_code.%` span → the
  // `claude_code` structural agent). A plain LLM/tool span (no agent.name, not claude_code.*) is
  // still excluded. chain-kind is DELIBERATELY excluded (control-flow node, not a named agent —
  // ADR 0002 risk-1). All correlated sub-derivations match against the SAME derived name.
  // Project agent_name as a plain column in a derived table FIRST, so the outer GROUP BY is on a
  // column (not a jsonb/CASE expression) and the correlated subqueries can reference the grouped
  // `base.agent_name` (Postgres rejects an ungrouped expression in a correlated subquery, 42803).
  const res = await db.execute(sql`
    SELECT
      base.agent_name AS name,
      min(base.ingested_at) AS first_seen,
      max(base.ingested_at) AS last_seen,
      count(DISTINCT base.trace_id)::int AS run_count,
      array_remove(array_agg(DISTINCT base.agent_version), NULL) AS versions,
      (SELECT s3.attributes->>'agent.system_prompt'
         FROM spans s3
        WHERE ${DERIVED_AGENT_NAME_SQL("s3")} = base.agent_name
          AND s3.workspace_id = ${workspaceId}
          AND nullif(btrim(s3.attributes->>'agent.system_prompt'), '') IS NOT NULL
        ORDER BY s3.ingested_at DESC
        LIMIT 1) AS system_prompt,
      COALESCE((SELECT array_agg(DISTINCT tl.tool_name)
         FROM spans tl
        WHERE tl.tool_name IS NOT NULL
          AND tl.workspace_id = ${workspaceId}
          AND tl.parent_span_id IN (SELECT s2.span_id FROM spans s2
                                     WHERE ${DERIVED_AGENT_NAME_SQL("s2")} = base.agent_name
                                       AND s2.workspace_id = ${workspaceId})
      ), ARRAY[]::text[]) AS tools
    FROM (
      SELECT ${DERIVED_AGENT_NAME_SQL("spans")} AS agent_name,
             attributes->>'agent.version' AS agent_version,
             trace_id,
             ingested_at
        FROM spans
       WHERE ${DERIVED_AGENT_NAME_SQL("spans")} IS NOT NULL
         AND workspace_id = ${workspaceId}
    ) base
    GROUP BY base.agent_name
    ORDER BY max(base.ingested_at) DESC
  `);
  const rows = rowsAs(res, agentRowSchema, "aggregateAgents");
  const now = new Date();
  return rows.map((r): Agent => {
    const raw: RawAgent = {
      name: r.name,
      firstSeenAt: isoTimestamp(r.first_seen),
      latestSeenAt: isoTimestamp(r.last_seen),
      runCount: r.run_count,
      versions: r.versions ?? [],
      tools: r.tools ?? [],
      systemPrompt: r.system_prompt };
    return shapeAgent(raw, { now });
  });
}
