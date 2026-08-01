/**
 * M99 (audit B-M1) — the shared SQL fragments + row mappers used by every DrizzleSpanRepository role.
 * Extracted into their own module so the per-role files (trace-read / aggregate / session / …) and the
 * facade all import them WITHOUT a facade↔role import cycle (ADR-1). Pure — no db handle, no state.
 */
import { sql } from "drizzle-orm";

import type { Span } from "../../domain/observability/span.js";
import { ERROR_STATUS_CODES } from "../../domain/observability/tool-stats.js";
import type { SpanClause } from "../../domain/observability/span-query.js";
import type { TraceListItem } from "../../domain/observability/trace-list.js";
import { spans, traces } from "./schema.js";

/** `s.status_code IN ('2','ERROR',…)` fragment (M30 — same error vocabulary as the trace aggregate). */
export const ERROR_CODES_IN = sql`(${sql.join(
  ERROR_STATUS_CODES.map((v) => sql`${v}`),
  sql`, `,
)})`;

/**
 * M97 (B-M2) — the clamped span-latency-in-ms expression, shared by every latency percentile.
 * A negative duration (clock skew) clamps to 0; nanos → ms via 1e6. One place to change the
 * semantics; embedded into raw `sql` templates via `sql.raw`.
 */
export const LATENCY_MS_EXPR = "greatest(0, (end_time_unix_nano::numeric - start_time_unix_nano::numeric) / 1e6)";

/**
 * SQL fragment computing a span's SEMANTIC kind on alias `s` — mirrors the UI's
 * `deriveKindFromSignals` precedence (tool > retriever > embedding > llm >
 * chain[has children] > unknown). M30 ADR D3: the stored `spans.kind` is the OTLP
 * numeric kind, so `kind:` MUST derive from the same `gen_ai.*` / model / has-children
 * signals the UI uses, or the filter would not match what the operator sees.
 */
// M85 (ADR 0002) — the derived agent name for the Agents catalog: the explicit `agent.name`
// attribute, else the conservative structural rule (a `claude_code.`-prefixed span → the
// `claude_code` structural agent). NULL for a non-agent span (excluded from the catalog). Explicit
// BEATS structural. `starts_with` is an EXACT prefix match — deliberately not `LIKE 'claude_code.%'`,
// whose `_` are single-char wildcards (would false-match `claudeXcodeY.…`) and whose `%` is a
// wildcard (review LOW). `alias` is a compile-time-enforced union of the three legal span-table
// aliases (never user input — no injection surface, and no `sql.raw` variable can slip in).
export const DERIVED_AGENT_NAME_SQL = (alias: "s2" | "s3" | "spans") => sql`CASE
  WHEN ${sql.raw(alias)}.attributes->>'agent.name' IS NOT NULL THEN ${sql.raw(alias)}.attributes->>'agent.name'
  WHEN starts_with(${sql.raw(alias)}.name, 'claude_code.') THEN 'claude_code'
  ELSE NULL
END`;

// M140 (ADR D1) — the end-user identity, defined ONCE. M131 A3 settled the rule: best-effort
// `user.id`, falling back to the OTel semantic-convention `gen_ai.user.id`. The order is the rule,
// not a detail — it decides which id wins when a client sends both. It lived duplicated inside
// session-repository.ts (two copies of the same coalesce) until the usage-by-user report became a
// third consumer; a business rule with N copies has N truths, and a fix to one leaves the others
// stale in silence. NULL when neither key is present — callers decide what an un-attributed span
// means (the usage report buckets it as `unattributed`; the session list renders an em-dash).
//
// `alias` is a compile-time-enforced union of the span-table aliases the real call sites use — `sp`
// in session-repository.ts:108, `spans` in the aggregate queries. It is never user input, so no
// `sql.raw` variable can slip in. Widening it to `string` to fit a new call site would reopen that
// surface: add the literal to the union instead.
export const END_USER_ID_SQL = (alias: "sp" | "spans") =>
  sql`coalesce(${sql.raw(alias)}.attributes->>'user.id', ${sql.raw(alias)}.attributes->>'gen_ai.user.id')`;

export const DERIVED_SPAN_KIND_SQL = sql`CASE
  WHEN s.attributes->>'gen_ai.tool.name' IS NOT NULL OR s.attributes->>'gen_ai.operation.name' = 'execute_tool' THEN 'tool'
  WHEN s.attributes->>'gen_ai.operation.name' IN ('retrieve', 'search') THEN 'retriever'
  WHEN s.attributes->>'gen_ai.operation.name' IN ('embeddings', 'embedding') THEN 'embedding'
  WHEN s.attributes->>'gen_ai.operation.name' IN ('chat', 'text_completion') OR s.model IS NOT NULL THEN 'llm'
  WHEN EXISTS (SELECT 1 FROM spans c WHERE c.parent_span_id = s.span_id AND c.workspace_id = s.workspace_id) THEN 'chain'
  ELSE 'unknown'
END`;

/** One span-query clause → a predicate on span alias `s` (every value is a bound param — no injection). */
export function spanClauseSql(c: SpanClause) {
  switch (c.field) {
    case "name":
      return sql`s.name = ${c.value}`;
    case "model":
      return sql`s.model = ${c.value}`;
    case "status":
      return c.value === "error"
        ? sql`s.status_code IN ${ERROR_CODES_IN}`
        : sql`(s.status_code IS NULL OR s.status_code NOT IN ${ERROR_CODES_IN})`;
    case "kind":
      return sql`(${DERIVED_SPAN_KIND_SQL}) = ${c.value}`;
    case "attr":
      // M92 — arbitrary attribute: the KEY is bound as a jsonb path operand (data, not SQL) and
      // the VALUE as a bind param. Drizzle emits `attributes ->> $1 = $2` — injection-safe by
      // parameterization (the ATTR_KEY_RE shape check upstream is defense-in-depth, not the guard).
      return sql`s.attributes->>${c.key} = ${c.value}`;
  }
}

export type SpanRow = typeof spans.$inferInsert;

export function toRow(span: Span, workspaceId: string): SpanRow {
  return {
    spanId: span.spanId,
    workspaceId,
    traceId: span.traceId,
    parentSpanId: span.parentSpanId ?? null,
    name: span.name,
    kind: span.kind ?? null,
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    statusCode: span.statusCode ?? null,
    statusMessage: span.statusMessage ?? null,
    model: span.model ?? null,
    provider: span.provider ?? null,
    inputTokens: span.inputTokens ?? null,
    outputTokens: span.outputTokens ?? null,
    toolName: span.toolName ?? null,
    sessionId: span.sessionId ?? null,
    // M12: input/output text + events (already capped by ingest extraction).
    inputValue: span.inputValue ?? null,
    outputValue: span.outputValue ?? null,
    // M34: Claude Code perf/cost signals.
    ttftMs: span.ttftMs ?? null,
    cacheReadTokens: span.cacheReadTokens ?? null,
    cacheCreationTokens: span.cacheCreationTokens ?? null,
    events: span.events ?? null,
    attributes: span.attributes ?? null,
  };
}

export function fromRow(row: typeof spans.$inferSelect): Span {
  return {
    spanId: row.spanId,
    traceId: row.traceId,
    name: row.name,
    startTimeUnixNano: row.startTimeUnixNano,
    endTimeUnixNano: row.endTimeUnixNano,
    ...(row.parentSpanId != null ? { parentSpanId: row.parentSpanId } : {}),
    ...(row.kind != null ? { kind: row.kind } : {}),
    ...(row.statusCode != null ? { statusCode: row.statusCode } : {}),
    ...(row.statusMessage != null ? { statusMessage: row.statusMessage } : {}),
    ...(row.model != null ? { model: row.model } : {}),
    ...(row.provider != null ? { provider: row.provider } : {}),
    ...(row.inputTokens != null ? { inputTokens: row.inputTokens } : {}),
    ...(row.outputTokens != null ? { outputTokens: row.outputTokens } : {}),
    ...(row.toolName != null ? { toolName: row.toolName } : {}),
    ...(row.sessionId != null ? { sessionId: row.sessionId } : {}),
    ...(row.inputValue != null ? { inputValue: row.inputValue } : {}),
    ...(row.outputValue != null ? { outputValue: row.outputValue } : {}),
    ...(row.ttftMs != null ? { ttftMs: row.ttftMs } : {}),
    ...(row.cacheReadTokens != null
      ? { cacheReadTokens: row.cacheReadTokens }
      : {}),
    ...(row.cacheCreationTokens != null
      ? { cacheCreationTokens: row.cacheCreationTokens }
      : {}),
    ...(row.events != null
      ? { events: row.events as Span["events"] }
      : {}),
    ...(row.attributes != null
      ? { attributes: row.attributes as Record<string, unknown> }
      : {}),
  };
}

/**
 * Map a `traces` aggregate row to the stable list DTO (M3 D2). Computes
 * `durationMs` from the nano timestamps with BigInt math (no 2^53 precision
 * loss); omits keys that are null so the `.strict()` DTO never carries a column.
 */
/** Root-span fields the M18 LATERAL join adds to a traces row (all nullable). */
export interface EnrichedTraceRow {
  rootModel: string | null;
  rootOperationName: string | null;
  rootToolName: string | null;
  rootInputValue: string | null;
  rootOutputValue: string | null;
  // M26b: per-trace online-eval row count (the executions-list "Evals" column).
  evaluationsCount: number | null;
}

/**
 * Is `s` a syntactically valid UUID? Dataset ids are uuid columns (M26d); querying a
 * uuid column with a non-uuid string makes Postgres throw `invalid input syntax`. The
 * routes pass path params verbatim, so an unknown/garbage id must read as "absent"
 * (null / false → 404), never a 500. Guard before any `eq(datasets.id, …)`.
 */
/** Truncate a span's input/output to a list-cell preview (≤120 chars), surrogate-safe (EC-3). */
export function preview(text: string): string {
  const chars = Array.from(text);
  return chars.length > 120 ? `${chars.slice(0, 120).join("")}…` : text;
}

export function traceRowToItem(
  row: typeof traces.$inferSelect & Partial<EnrichedTraceRow>,
): TraceListItem {
  const item: TraceListItem = { traceId: row.traceId };
  if (row.sessionId != null) item.sessionId = row.sessionId;
  if (row.name != null) item.name = row.name;
  if (row.startTimeUnixNano != null) {
    item.startTimeUnixNano = row.startTimeUnixNano;
    if (row.endTimeUnixNano != null) {
      const dur = Number(
        (BigInt(row.endTimeUnixNano) - BigInt(row.startTimeUnixNano)) /
          1_000_000n,
      );
      if (dur >= 0) item.durationMs = dur;
    }
  }
  if (row.statusCode != null) item.statusCode = row.statusCode;
  if (row.totalTokens != null) item.totalTokens = row.totalTokens;
  // M18 — enriched columns (existing traces cols + root-span LATERAL).
  if (row.endTimeUnixNano != null) item.endTimeUnixNano = row.endTimeUnixNano;
  if (row.costUsd != null) item.costUsd = row.costUsd;
  if (row.rootModel != null) item.model = row.rootModel;
  if (row.rootOperationName != null) {
    item.rootOperationName = row.rootOperationName;
  }
  if (row.rootToolName != null) item.rootToolName = row.rootToolName;
  if (row.rootInputValue != null) item.inputPreview = preview(row.rootInputValue);
  if (row.rootOutputValue != null) {
    item.outputPreview = preview(row.rootOutputValue);
  }
  // M26b: surface the per-trace eval count when present (>0). Omitted otherwise so
  // the list does not render a "0" column for traces with no evaluations.
  if (row.evaluationsCount != null && row.evaluationsCount > 0) {
    item.evaluationsCount = row.evaluationsCount;
  }
  return item;
}
