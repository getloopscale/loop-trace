import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNull, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import type { Span } from "../../domain/span.js";
import { DEFAULT_WORKSPACE_ID } from "../../domain/principal.js";
import { NameConflictError, isUniqueViolation } from "../../domain/errors.js";
import { isUuid } from "./uuid.js";
import type { AskFeedbackInput, CopilotFeedbackRecord } from "../../domain/copilot-feedback.js";
import type {
  SpanRepository,
  TraceTreeNode,
} from "../../domain/span-repository.js";
import type {
  ListTracesOptions,
  TraceListItem,
  TraceListResponse,
} from "../../domain/trace-list.js";
import type {
  LabelingQueueItem,
  LabelingQueuePage,
  LabelingQueueStatus,
  NormalizedResolution,
} from "../../domain/labeling-queue.js";
import type { ExperimentRun, ExperimentRunItem, RunStatus, RunVariant } from "../../domain/experiment.js";
import { aggregateRun } from "../../domain/experiment.js";
import { computeTraceCost, type PriceTable } from "../../domain/pricing.js";
import { DEFAULT_PRICES } from "../../domain/default-prices.js";
import type {
  CostByPeriodResponse,
  CostPeriod,
  TraceCost,
} from "../../domain/cost.js";
import { round3, ERROR_STATUS_CODES, type ToolStatsResponse } from "../../domain/tool-stats.js";
import {
  shapeNorthStarBuckets,
  type BucketRow,
  type NorthStarResponse,
} from "../../domain/north-star.js";
import {
  shapeObservability,
  RANGE_BUCKETS,
  type ObservabilityRange,
  type ObservabilityResponse,
  type RawObservability,
} from "../../domain/observability.js";
import {
  shapeSessionDetail,
  isoTimestamp,
  type SessionListResponse,
  type SessionListItem,
  type SessionDetailResponse,
  type RawSessionDetail,
} from "../../domain/session.js";
import type { PruneStats } from "../../domain/retention.js";
import { parseSpanQuery, type SpanClause } from "../../domain/span-query.js";
import type { EvaluatorSummary } from "../../domain/evaluation.js";
import { spans, traces, sessions, replaySessions, traceTags, spanEvaluations, annotations, datasets, datasetItems, labelingQueueItems, experimentRuns, experimentRunItems, copilotFeedback } from "./schema.js";
import {
  DEFAULT_ANNOTATOR_KIND,
  type Annotation,
  type NormalizedAnnotation,
} from "../../domain/annotation.js";
import type { Dataset, DatasetDetail } from "../../domain/dataset.js";
import { shapeAgent, type Agent, type RawAgent } from "../../domain/agent-catalog.js";

/** Build a pg connection pool for the given Postgres URI. */
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

/** `s.status_code IN ('2','ERROR',…)` fragment (M30 — same error vocabulary as the trace aggregate). */
const ERROR_CODES_IN = sql`(${sql.join(
  ERROR_STATUS_CODES.map((v) => sql`${v}`),
  sql`, `,
)})`;

/**
 * SQL fragment computing a span's SEMANTIC kind on alias `s` — mirrors the UI's
 * `deriveKindFromSignals` precedence (tool > retriever > embedding > llm >
 * chain[has children] > unknown). M30 ADR D3: the stored `spans.kind` is the OTLP
 * numeric kind, so `kind:` MUST derive from the same `gen_ai.*` / model / has-children
 * signals the UI uses, or the filter would not match what the operator sees.
 */
// M85 (ADR 0002) — the derived agent name for the Agents catalog: the explicit `agent.name`
// attribute, else the conservative structural rule (a `claude_code.%` span → the `claude_code`
// structural agent). NULL for a non-agent span (excluded from the catalog). Explicit BEATS structural.
// `alias` is the span table alias in the caller's scope (interpolated as a raw identifier — a fixed
// internal literal, never user input, so no injection surface).
const DERIVED_AGENT_NAME_SQL = (alias: string) => sql`CASE
  WHEN ${sql.raw(alias)}.attributes->>'agent.name' IS NOT NULL THEN ${sql.raw(alias)}.attributes->>'agent.name'
  WHEN ${sql.raw(alias)}.name ILIKE 'claude_code.%' THEN 'claude_code'
  ELSE NULL
END`;

const DERIVED_SPAN_KIND_SQL = sql`CASE
  WHEN s.attributes->>'gen_ai.tool.name' IS NOT NULL OR s.attributes->>'gen_ai.operation.name' = 'execute_tool' THEN 'tool'
  WHEN s.attributes->>'gen_ai.operation.name' IN ('retrieve', 'search') THEN 'retriever'
  WHEN s.attributes->>'gen_ai.operation.name' IN ('embeddings', 'embedding') THEN 'embedding'
  WHEN s.attributes->>'gen_ai.operation.name' IN ('chat', 'text_completion') OR s.model IS NOT NULL THEN 'llm'
  WHEN EXISTS (SELECT 1 FROM spans c WHERE c.parent_span_id = s.span_id AND c.workspace_id = s.workspace_id) THEN 'chain'
  ELSE 'unknown'
END`;

/** One span-query clause → a predicate on span alias `s` (every value is a bound param — no injection). */
function spanClauseSql(c: SpanClause) {
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
  }
}

type SpanRow = typeof spans.$inferInsert;

function toRow(span: Span, workspaceId: string): SpanRow {
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

function fromRow(row: typeof spans.$inferSelect): Span {
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
interface EnrichedTraceRow {
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
function preview(text: string): string {
  const chars = Array.from(text);
  return chars.length > 120 ? `${chars.slice(0, 120).join("")}…` : text;
}

function traceRowToItem(
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

export class DrizzleSpanRepository implements SpanRepository {
  constructor(
    private readonly db: NodePgDatabase,
    // Configurable per-model price table (M5 ADR D1 — injectable for risk #1).
    private readonly priceTable: PriceTable = DEFAULT_PRICES,
  ) {}

  async save(
    spansToSave: Span[],
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<void> {
    if (spansToSave.length === 0) return;
    // Dedupe intra-batch duplicate spanId (M0 EC-1).
    const unique = [...new Map(spansToSave.map((s) => [s.spanId, s])).values()];
    // Sorted so concurrent multi-trace batches acquire advisory locks in a
    // consistent order — eliminates the AB/BA deadlock window (review F-otlp-5).
    const traceIds = [...new Set(unique.map((s) => s.traceId))].sort();
    const sessionIds = [
      ...new Set(
        unique.map((s) => s.sessionId).filter((id): id is string => id != null),
      ),
    ];

    await this.db.transaction(async (tx) => {
      await tx
        .insert(spans)
        .values(unique.map((s) => toRow(s, workspaceId)))
        .onConflictDoNothing({ target: [spans.workspaceId, spans.spanId] });

      // M26: persist extracted online-evals to the side-table. Idempotent on
      // (span_id, name) so re-ingest of the same span never duplicates rows.
      const evalRows = unique.flatMap((s) =>
        (s.evaluations ?? []).map((e) => ({
          workspaceId,
          spanId: s.spanId,
          traceId: s.traceId,
          name: e.name,
          score: e.score ?? null,
          label: e.label ?? null,
          explanation: e.explanation ?? null,
        })),
      );
      if (evalRows.length > 0) {
        await tx
          .insert(spanEvaluations)
          .values(evalRows)
          .onConflictDoNothing({
            target: [
              spanEvaluations.workspaceId,
              spanEvaluations.spanId,
              spanEvaluations.name,
            ],
          });
      }

      // Recompute each affected trace's aggregate FROM the spans table (idempotent
      // under retry + race-safe — ADR D3 / EC-1). Never an incremental sum.
      for (const traceId of traceIds) {
        // Serialize concurrent ingests of the SAME trace so each recompute sees
        // all prior-committed spans (READ COMMITTED recompute alone undercounts
        // under interleaving). pg_advisory_xact_lock releases at commit.
        // Keyed on the (workspace, trace) PAIR — trace_id is no longer globally
        // unique (composite PK), so locking on trace_id alone would falsely
        // serialize two tenants ingesting a colliding trace_id (M22).
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${workspaceId + ":" + traceId}))`,
        );
        // Trace-level status = 'error' if ANY span errored (error propagates from
        // child to parent — Phoenix convention), else 'ok'. This populates the
        // previously-unset traces.status_code so the list can surface + filter it
        // (M9); error tokens are the same constant the UI/tool-stats use.
        const errorList = ERROR_STATUS_CODES.map((c) => `'${c}'`).join(", ");
        await tx.execute(sql`
          INSERT INTO traces (trace_id, workspace_id, session_id, name, start_time_unix_nano, end_time_unix_nano, input_tokens, output_tokens, total_tokens, cost_usd, status_code, updated_at)
          SELECT
            ${traceId},
            ${workspaceId},
            max(session_id),
            (array_agg(name ORDER BY (parent_span_id IS NOT NULL), start_time_unix_nano::numeric))[1],
            min(start_time_unix_nano::numeric)::text,
            max(end_time_unix_nano::numeric)::text,
            sum(input_tokens)::int,
            sum(output_tokens)::int,
            (coalesce(sum(input_tokens),0) + coalesce(sum(output_tokens),0))::int,
            NULL,
            CASE WHEN bool_or(status_code IN (${sql.raw(errorList)})) THEN 'error' ELSE 'ok' END,
            now()
          FROM spans WHERE trace_id = ${traceId} AND workspace_id = ${workspaceId}
          ON CONFLICT (workspace_id, trace_id) DO UPDATE SET
            session_id = excluded.session_id,
            name = excluded.name,
            start_time_unix_nano = excluded.start_time_unix_nano,
            end_time_unix_nano = excluded.end_time_unix_nano,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            total_tokens = excluded.total_tokens,
            status_code = excluded.status_code,
            updated_at = now()
        `);

        // Compute USD cost from per-model token sums via the pure price function
        // (M5 ADR D1), inside the SAME advisory lock → race-safe + idempotent.
        const usage = await tx.execute(sql`
          SELECT model,
                 coalesce(sum(input_tokens), 0)::int AS i,
                 coalesce(sum(output_tokens), 0)::int AS o
          FROM spans WHERE trace_id = ${traceId} AND workspace_id = ${workspaceId} AND model IS NOT NULL
          GROUP BY model
        `);
        const cost = computeTraceCost(
          (usage.rows as { model: string; i: number; o: number }[]).map((r) => ({
            model: r.model,
            inputTokens: r.i,
            outputTokens: r.o,
          })),
          this.priceTable,
        );
        await tx.execute(
          sql`UPDATE traces SET cost_usd = ${cost} WHERE trace_id = ${traceId} AND workspace_id = ${workspaceId}`,
        );
      }

      for (const sessionId of sessionIds) {
        await tx.execute(sql`
          INSERT INTO sessions (session_id, workspace_id, first_seen_at, last_seen_at)
          VALUES (${sessionId}, ${workspaceId}, now(), now())
          ON CONFLICT (workspace_id, session_id) DO UPDATE SET last_seen_at = now()
        `);
      }
    });
  }

  async getBySpanId(
    spanId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<Span | null> {
    const rows = await this.db
      .select()
      .from(spans)
      .where(and(eq(spans.spanId, spanId), eq(spans.workspaceId, workspaceId)))
      .limit(1);
    const row = rows[0];
    return row ? fromRow(row) : null;
  }

  async getTraceTree(
    traceId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<TraceTreeNode | null> {
    // Deterministic sibling order at the source: numeric start time, then spanId
    // (the PK — a stable total order). Makes the persisted tree reproducible across
    // fetches and aligns the rendered tree with the replay step order (review F-rp-1).
    // M22: scoped by workspace — a trace's spans never cross the tenant boundary.
    const rows = await this.db
      .select()
      .from(spans)
      .where(and(eq(spans.traceId, traceId), eq(spans.workspaceId, workspaceId)))
      .orderBy(sql`start_time_unix_nano::numeric`, spans.spanId);
    if (rows.length === 0) return null;

    // Read-time assembly over ALL persisted spans → out-of-order batches and
    // orphans (parent absent) resolve correctly (EC-2 / Q3).
    const nodes = new Map<string, TraceTreeNode>();
    for (const r of rows) nodes.set(r.spanId, { ...fromRow(r), children: [] });
    const all = [...nodes.values()];

    // M26: attach each span's online-evaluations (side-table) to its tree node so
    // the trace-detail Evaluations tab can read them without a second round-trip.
    const evalRows = await this.db
      .select()
      .from(spanEvaluations)
      .where(
        and(
          eq(spanEvaluations.traceId, traceId),
          eq(spanEvaluations.workspaceId, workspaceId),
        ),
      );
    for (const e of evalRows) {
      const node = nodes.get(e.spanId);
      if (node == null) continue;
      (node.evaluations ??= []).push({
        name: e.name,
        ...(e.score != null ? { score: e.score } : {}),
        ...(e.label != null ? { label: e.label } : {}),
        ...(e.explanation != null ? { explanation: e.explanation } : {}),
      });
    }

    // Effective parent: null when the parent is absent, self-referential, or
    // would form a cycle (walk up bounded by node count). Severing cyclic edges
    // keeps the result a DAG/tree so JSON serialization can never blow up on a
    // malicious/buggy parent loop (review F-otlp-7).
    const effectiveParent = (node: TraceTreeNode): TraceTreeNode | undefined => {
      const pid = node.parentSpanId;
      if (pid == null || pid === node.spanId || !nodes.has(pid)) return undefined;
      let cur = nodes.get(pid);
      let steps = 0;
      while (cur && steps++ <= nodes.size) {
        if (cur.spanId === node.spanId) return undefined; // cycle → treat as root
        const next = cur.parentSpanId;
        if (next == null || next === cur.spanId || !nodes.has(next)) break;
        cur = nodes.get(next);
      }
      return nodes.get(pid);
    };

    // Primary root = earliest true root (parent null), else earliest node. M1
    // returns a single tree: a trace with MULTIPLE root spans attaches the extra
    // roots (and orphans) under the primary root — a documented M1 simplification
    // (review F-otlp-6); a forest API is deferred.
    const byStart = (a: TraceTreeNode, b: TraceTreeNode) =>
      a.startTimeUnixNano.length - b.startTimeUnixNano.length ||
      (a.startTimeUnixNano < b.startTimeUnixNano ? -1 : 1);
    const trueRoots = all.filter((n) => n.parentSpanId == null).sort(byStart);
    const primary = trueRoots[0] ?? [...all].sort(byStart)[0]!;
    for (const node of all) {
      if (node === primary) continue;
      (effectiveParent(node) ?? primary).children.push(node);
    }
    return primary;
  }

  async listTraces(
    opts: ListTracesOptions = {},
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<TraceListResponse> {
    // M9: whitelisted filter (status/model/time) + sort (recent/latency/tokens/
    // cost, dir) + bounded limit. No opts → newest-50 by updated_at (legacy).
    // Maps rows → strict DTO so no Drizzle column leaks (M3 D2).
    // M22: scoped by workspace — the filtered `traces` set bounds the LATERAL +
    // inArray subqueries (a cross-workspace traceId is never in the filtered set).
    const conds: (SQL | undefined)[] = [eq(traces.workspaceId, workspaceId)];
    if (opts.from) conds.push(gte(traces.updatedAt, new Date(opts.from)));
    if (opts.to) conds.push(lte(traces.updatedAt, new Date(opts.to)));
    // M52: advanced trace-level filters (cost_usd / total_tokens ranges + session_id). All
    // are `traces` columns (no span join). Use `!= null` so a legitimate `0` bound is honored;
    // an inverted range (min > max) yields no rows (fail-soft, like the from/to window).
    if (opts.minCostUsd != null) conds.push(gte(traces.costUsd, opts.minCostUsd));
    if (opts.maxCostUsd != null) conds.push(lte(traces.costUsd, opts.maxCostUsd));
    if (opts.minTokens != null) conds.push(gte(traces.totalTokens, opts.minTokens));
    if (opts.maxTokens != null) conds.push(lte(traces.totalTokens, opts.maxTokens));
    if (opts.sessionId) conds.push(eq(traces.sessionId, opts.sessionId));
    if (opts.status === "error") {
      // The status filter is coupled to the recompute's normalized vocabulary
      // ('ok'/'error'), the ONLY writer of traces.status_code. A trace ingested
      // before M9 and never re-recomputed carries NULL (→ counts as ok); a future
      // raw-token write would break this — keep status_code normalized at write.
      conds.push(eq(traces.statusCode, "error"));
    } else if (opts.status === "ok") {
      // EC-1: a bare NOT-error would drop NULL-status rows (NULL NOT IN → NULL);
      // treat unset status as ok so legacy rows are not silently hidden.
      conds.push(
        or(isNull(traces.statusCode), notInArray(traces.statusCode, ["error"])),
      );
    }
    if (opts.model) {
      // model lives on spans, not the traces aggregate (D2) — same selectDistinct
      // + inArray subquery the M6 tool drill-down uses.
      const modelTraceIds = this.db
        .selectDistinct({ traceId: spans.traceId })
        .from(spans)
        .where(
          and(eq(spans.model, opts.model), eq(spans.workspaceId, workspaceId)),
        );
      conds.push(inArray(traces.traceId, modelTraceIds));
    }
    if (opts.tag) {
      // M14: same selectDistinct + inArray subquery as the model filter — composes
      // with the other conds without changing the row shape traceRowToItem expects.
      const taggedTraceIds = this.db
        .selectDistinct({ traceId: traceTags.traceId })
        .from(traceTags)
        .where(
          and(
            eq(traceTags.tag, opts.tag),
            eq(traceTags.workspaceId, workspaceId),
          ),
        );
      conds.push(inArray(traces.traceId, taggedTraceIds));
    }
    // M24: one parsed tsquery, reused by the filter AND the relevance rank so both
    // interpret `q` identically (`websearch_to_tsquery` is total — never throws on
    // malformed `q`, D3; `${opts.q}` is a bound param — no injection).
    const tsq =
      opts.q != null
        ? sql`websearch_to_tsquery('english', ${opts.q})`
        : undefined;
    if (tsq) {
      // Full-text search over ANY span's input/output (D1 — not root-only; EXISTS
      // lists the trace once, no row multiplication).
      conds.push(
        sql`EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = ${traces.traceId} AND s.workspace_id = ${workspaceId} AND s.search_tsv @@ ${tsq})`,
      );
    }
    // M30: span-query DSL — a trace matches iff ONE span satisfies EVERY clause
    // (span-scoped AND via EXISTS, D2). The parser is total, so a query with no valid
    // clauses adds no condition (unfiltered). `kind:` uses the derived-kind CASE (D3).
    if (opts.spanQuery) {
      const { clauses } = parseSpanQuery(opts.spanQuery);
      if (clauses.length > 0) {
        const preds = sql.join(clauses.map(spanClauseSql), sql` AND `);
        conds.push(
          sql`EXISTS (SELECT 1 FROM spans s WHERE s.trace_id = ${traces.traceId} AND s.workspace_id = ${workspaceId} AND ${preds})`,
        );
      }
    }
    const where = conds.length > 0 ? and(...conds) : undefined;

    // EC-2: latency sorts on the nullable TEXT nanos via a numeric cast, clamping
    // clock-skew negatives to 0 (M6 consistency); NULLS LAST so missing values
    // never lead; secondary updated_at DESC makes ties deterministic (Q1).
    // M24 (D4): when searching with no explicit sort, order by relevance — the
    // trace's best matching span's ts_rank. An explicit orderBy still wins (search
    // is a filter; the user can still sort matches by latency/tokens/cost).
    const relevanceSort =
      tsq != null && (opts.orderBy == null || opts.orderBy === "recent");
    const sortCol = relevanceSort
      ? sql`(SELECT max(ts_rank(s.search_tsv, ${tsq})) FROM spans s WHERE s.trace_id = ${traces.traceId} AND s.workspace_id = ${workspaceId} AND s.search_tsv @@ ${tsq})`
      : opts.orderBy === "latency"
        ? // A one-sided NULL (only start OR only end) must sort NULLS LAST, not as
          // 0 — `greatest(0, end - NULL)` returns 0, so guard with an explicit CASE
          // that yields NULL unless BOTH bounds are present (F-data-1).
          sql`CASE WHEN ${traces.startTimeUnixNano} IS NULL OR ${traces.endTimeUnixNano} IS NULL THEN NULL ELSE greatest(0, (${traces.endTimeUnixNano}::numeric - ${traces.startTimeUnixNano}::numeric)) END`
        : opts.orderBy === "tokens"
          ? sql`${traces.totalTokens}`
          : opts.orderBy === "cost"
            ? sql`${traces.costUsd}`
            : sql`${traces.updatedAt}`;
    const dir = opts.dir === "asc" ? sql`asc` : sql`desc`;
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0; // M56 — export pagination

    // M18: derive the trace's representative model/kind/input/output from its
    // ROOT span (parent_span_id IS NULL, earliest) via a single correlated LATERAL
    // join — one indexed root-span lookup per row, no new column, no migration.
    const root = this.db
      .select({
        model: spans.model,
        // gen_ai operation/tool signals live in the attributes bag (not typed
        // columns); ->> extracts them as text. The web derives the semantic kind.
        operationName: sql<
          string | null
        >`${spans.attributes}->>'gen_ai.operation.name'`.as("op_name"),
        // M34: the typed `tool_name` column (Claude Code's `tool_name`) wins; fall
        // back to the `gen_ai.tool.name` attribute for producers that only emit it.
        toolName: sql<
          string | null
        >`coalesce(${spans.toolName}, ${spans.attributes}->>'gen_ai.tool.name')`.as(
          "tool_name",
        ),
      })
      .from(spans)
      .where(
        and(
          eq(spans.traceId, traces.traceId),
          eq(spans.workspaceId, workspaceId),
          isNull(spans.parentSpanId),
        ),
      )
      .orderBy(asc(sql`${spans.startTimeUnixNano}::numeric`))
      .limit(1)
      .as("root");

    // M35: the I/O PREVIEW comes from a representative span — the root when it has
    // I/O (demo/langfuse, unchanged), else the earliest span in the trace with a
    // non-null input/output. A Claude Code trace's root is `claude_code.llm_request`
    // (no I/O); its first `claude_code.tool` child carries the command + result.
    // Kind stays root-derived (above); only the I/O sourcing differs.
    const repr = this.db
      .select({
        inputValue: spans.inputValue,
        outputValue: spans.outputValue,
      })
      .from(spans)
      .where(
        and(
          eq(spans.traceId, traces.traceId),
          eq(spans.workspaceId, workspaceId),
          sql`(${spans.inputValue} IS NOT NULL OR ${spans.outputValue} IS NOT NULL)`,
        ),
      )
      .orderBy(
        sql`(${spans.parentSpanId} IS NULL) DESC`,
        asc(sql`${spans.startTimeUnixNano}::numeric`),
      )
      .limit(1)
      .as("repr");

    const rows = await this.db
      .select({
        ...getTableColumns(traces),
        rootModel: root.model,
        rootOperationName: root.operationName,
        rootToolName: root.toolName,
        rootInputValue: repr.inputValue,
        rootOutputValue: repr.outputValue,
        // M26b: per-trace online-eval count for the "Evals" list column (read-only,
        // M26 data) — a correlated count on the indexed span_evaluations.trace_id.
        evaluationsCount: sql<number>`(SELECT count(*)::int FROM span_evaluations se WHERE se.trace_id = ${traces.traceId} AND se.workspace_id = ${workspaceId})`.as(
          "evaluations_count",
        ),
      })
      .from(traces)
      .leftJoinLateral(root, sql`true`)
      .leftJoinLateral(repr, sql`true`)
      .where(where)
      .orderBy(sql`${sortCol} ${dir} nulls last`, desc(traces.updatedAt))
      .limit(limit)
      .offset(offset);
    // M81: the workspace-scoped total over the SAME `where` (no LATERAL/order needed for a count) —
    // the labeling-queue two-query technique — so the client can render a pager. Echo the applied window.
    const totalRows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(traces)
      .where(where);
    return { traces: rows.map(traceRowToItem), total: totalRows[0]?.n ?? 0, limit, offset };
  }

  async getTraceCost(
    traceId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<TraceCost | null> {
    const rows = await this.db
      .select()
      .from(traces)
      .where(
        and(eq(traces.traceId, traceId), eq(traces.workspaceId, workspaceId)),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      traceId: row.traceId,
      costUsd: row.costUsd ?? 0,
      inputTokens: row.inputTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
      totalTokens: row.totalTokens ?? 0,
    };
  }

  async aggregateCostByPeriod(
    period: CostPeriod,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<CostByPeriodResponse> {
    // `period` is whitelisted to the union literal (no raw interpolation) AND
    // bound as a parameter; date_trunc buckets the precomputed cost. The 90-day
    // `updated_at` window bounds the scan and lets `traces_updated_at_idx` serve a
    // range scan (risk #2) instead of a full-table aggregate.
    const trunc = period === "week" ? "week" : "day";
    const res = await this.db.execute(sql`
      SELECT date_trunc(${trunc}, updated_at) AS bucket,
             coalesce(sum(cost_usd), 0)::double precision AS cost,
             coalesce(sum(total_tokens), 0)::int AS tokens,
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
      traceCount: r.n,
    }));
    return { period, buckets };
  }

  async aggregateToolStats(
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
    const res = await this.db.execute(sql`
      SELECT tool_name,
             count(*)::int AS call_count,
             count(*) FILTER (WHERE status_code IN (${sql.raw(errorList)}))::int AS error_count,
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY greatest(0, (end_time_unix_nano::numeric - start_time_unix_nano::numeric) / 1e6)
             )::double precision AS p50,
             percentile_cont(0.95) WITHIN GROUP (
               ORDER BY greatest(0, (end_time_unix_nano::numeric - start_time_unix_nano::numeric) / 1e6)
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
      p95Ms: round3(r.p95),
    }));
    return { tools };
  }

  async listTracesForTool(
    toolName: string,
    limit = 50,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<TraceListResponse> {
    // Drill-down (M6): executions whose spans include this tool, newest-active first.
    // Reuses the M3 TraceListResponse DTO (no new shape). Uses the query builder so
    // rows map to the camelCase row type `traceRowToItem` expects.
    const callingTraceIds = this.db
      .selectDistinct({ traceId: spans.traceId })
      .from(spans)
      .where(
        and(
          eq(spans.toolName, toolName),
          eq(spans.workspaceId, workspaceId),
          gte(spans.ingestedAt, sql`now() - interval '90 days'`),
        ),
      );
    const rows = await this.db
      .select()
      .from(traces)
      .where(
        and(
          inArray(traces.traceId, callingTraceIds),
          eq(traces.workspaceId, workspaceId),
        ),
      )
      .orderBy(desc(traces.updatedAt))
      .limit(limit);
    // M81: the drill-down reuses the paginated DTO. Compute the REAL workspace-scoped total over the
    // same predicate (not `rows.length`, which would under-report when matches exceed the limit).
    const drillWhere = and(inArray(traces.traceId, callingTraceIds), eq(traces.workspaceId, workspaceId));
    const totalRows = await this.db.select({ n: sql<number>`count(*)::int` }).from(traces).where(drillWhere);
    return { traces: rows.map(traceRowToItem), total: totalRows[0]?.n ?? 0, limit, offset: 0 };
  }

  async recordReplaySession(
    traceId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<void> {
    // One row per replay opened in the UI — the sole data source for the
    // "replay sessions per week" north-star (replay is otherwise client-only).
    await this.db.insert(replaySessions).values({ traceId, workspaceId });
  }

  async aggregateNorthStar(
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
    const tracesRes = await this.db.execute(sql`
      SELECT date_trunc('day', ingested_at) AS bucket,
             count(DISTINCT trace_id)::int AS count
      FROM spans
      WHERE ingested_at >= now() - interval '30 days' AND workspace_id = ${workspaceId}
      GROUP BY bucket
      ORDER BY bucket DESC
    `);
    const sessionsRes = await this.db.execute(sql`
      SELECT date_trunc('week', opened_at) AS bucket,
             count(*)::int AS count
      FROM replay_sessions
      WHERE opened_at >= now() - interval '12 weeks' AND workspace_id = ${workspaceId}
      GROUP BY bucket
      ORDER BY bucket DESC
    `);
    return {
      tracesPerDay: shapeNorthStarBuckets(tracesRes.rows as unknown as BucketRow[]),
      replaySessionsPerWeek: shapeNorthStarBuckets(
        sessionsRes.rows as unknown as BucketRow[],
      ),
    };
  }

  async aggregateObservability(
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
    const trafficRes = await this.db.execute(sql`
      SELECT date_trunc(${trunc}, updated_at) AS bucket,
             count(*)::int AS "traceCount",
             count(*) FILTER (WHERE status_code = 'error')::int AS "errorCount"
      FROM traces
      WHERE updated_at >= now() - ${sql.raw(`interval '${interval}'`)} AND workspace_id = ${workspaceId}
      GROUP BY bucket
      ORDER BY bucket ASC
    `);

    // Latency percentiles over clamped duration (ms). EC-1: only rows with BOTH
    // bounds present AND numeric enter the percentile (a NULL/garbage bound must
    // not error the cast nor count as a spurious 0ms); skew clamped via greatest.
    const latencyRes = await this.db.execute(sql`
      SELECT date_trunc(${trunc}, updated_at) AS bucket,
             percentile_cont(0.5)  WITHIN GROUP (ORDER BY greatest(0, (end_time_unix_nano::numeric - start_time_unix_nano::numeric) / 1e6))::double precision AS p50,
             percentile_cont(0.75) WITHIN GROUP (ORDER BY greatest(0, (end_time_unix_nano::numeric - start_time_unix_nano::numeric) / 1e6))::double precision AS p75,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY greatest(0, (end_time_unix_nano::numeric - start_time_unix_nano::numeric) / 1e6))::double precision AS p95,
             percentile_cont(0.99) WITHIN GROUP (ORDER BY greatest(0, (end_time_unix_nano::numeric - start_time_unix_nano::numeric) / 1e6))::double precision AS p99
      FROM traces
      WHERE updated_at >= now() - ${sql.raw(`interval '${interval}'`)} AND workspace_id = ${workspaceId}
        AND start_time_unix_nano ~ '^\\d+$' AND end_time_unix_nano ~ '^\\d+$'
      GROUP BY bucket
      ORDER BY bucket ASC
    `);

    // Tokens per (model, bucket) from spans (model lives on spans). EC-4: model
    // must be present. The range scan is index-backed by spans_ingested_at_idx (D4);
    // the GROUP BY model + non-selective IS NOT NULL are not served by spans_model_idx.
    const modelRes = await this.db.execute(sql`
      SELECT date_trunc(${trunc}, ingested_at) AS bucket,
             model,
             coalesce(sum(input_tokens), 0)::int AS "inputTokens",
             coalesce(sum(output_tokens), 0)::int AS "outputTokens"
      FROM spans
      WHERE ingested_at >= now() - ${sql.raw(`interval '${interval}'`)}
        AND model IS NOT NULL AND workspace_id = ${workspaceId}
      GROUP BY bucket, model
      ORDER BY bucket ASC
    `);

    const raw: RawObservability = {
      traffic: trafficRes.rows as unknown as RawObservability["traffic"],
      latency: (latencyRes.rows as unknown as { bucket: Date; p50: number | null; p75: number | null; p95: number | null; p99: number | null }[]).map(
        (r) => ({
          bucket: r.bucket,
          p50: r.p50 ?? 0,
          p75: r.p75 ?? 0,
          p95: r.p95 ?? 0,
          p99: r.p99 ?? 0,
        }),
      ),
      tokensByModel: modelRes.rows as unknown as RawObservability["tokensByModel"],
    };
    return shapeObservability(raw, range, this.priceTable);
  }

  async aggregateEvaluators(
    range: ObservabilityRange,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<EvaluatorSummary[]> {
    // M26: per-evaluator aggregate over the side-table, range-windowed by the
    // trace's updated_at (same RANGE_BUCKETS interval whitelist the M11 observability
    // uses — sql.raw of a hardcoded constant, never the request string).
    const { interval } = RANGE_BUCKETS[range];
    const window = sql.raw(`interval '${interval}'`);
    // count + avg score per evaluator (avg ignores NULL scores).
    const summaryRes = await this.db.execute(sql`
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
    const labelRes = await this.db.execute(sql`
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
        labels: labelsByName.get(r.name) ?? {},
      }),
    );
  }

  async listSessions(
    workspaceId: string = DEFAULT_WORKSPACE_ID,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<SessionListResponse> {
    // M81 — server-side pagination: clamp the window (default 50, cap 500 like traces) and expose a
    // workspace-scoped total (count of SESSIONS, the GROUP BY grain). The BFF already forwards limit/offset.
    const limit = Math.min(500, Math.max(1, Math.floor(opts.limit ?? 50)));
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    // One row per real session (only session.id-bearing traces — D3), with
    // scoped aggregates summed over the spans-derived traces table (D2). LEFT JOIN
    // so a session with zero member traces still lists (traceCount 0). Deterministic
    // tiebreaker on session_id (EC-7). Backed by sessions_last_seen_at_idx (D4).
    // M20: the first user message is the input of the earliest root span across
    // the session (a correlated scalar subquery, NOT a join — it returns one value
    // per session and must not perturb the GROUP BY). The `~ '^\d+$'` guard keeps
    // the numeric ORDER BY cast from erroring on legacy/garbage nanos (mirrors the
    // M11 latency guard). Mapped through preview() with the EC-1 guard below.
    const res = await this.db.execute(sql`
      SELECT s.session_id AS "sessionId",
             s.first_seen_at AS "firstSeenAt",
             s.last_seen_at AS "lastSeenAt",
             count(t.trace_id)::int AS "traceCount",
             coalesce(sum(t.cost_usd), 0)::double precision AS "costUsd",
             coalesce(sum(t.total_tokens), 0)::int AS "totalTokens",
             count(t.trace_id) FILTER (WHERE t.status_code = 'error')::int AS "errorCount",
             (SELECT count(*)::int
                FROM span_evaluations se
               WHERE se.workspace_id = ${workspaceId}
                 AND se.trace_id IN (SELECT te.trace_id FROM traces te
                                      WHERE te.session_id = s.session_id
                                        AND te.workspace_id = ${workspaceId})) AS "evaluationsCount",
             (SELECT sp.input_value
                FROM spans sp
                JOIN traces tt ON tt.trace_id = sp.trace_id AND tt.workspace_id = ${workspaceId}
               WHERE tt.session_id = s.session_id
                 AND sp.workspace_id = ${workspaceId}
                 AND sp.parent_span_id IS NULL
                 AND sp.start_time_unix_nano ~ '^\\d+$'
               ORDER BY sp.start_time_unix_nano::numeric ASC
               LIMIT 1) AS "firstMessageRaw"
      FROM sessions s
      LEFT JOIN traces t ON t.session_id = s.session_id AND t.workspace_id = s.workspace_id
      WHERE s.workspace_id = ${workspaceId}
      GROUP BY s.session_id, s.first_seen_at, s.last_seen_at
      ORDER BY s.last_seen_at DESC, s.session_id DESC
      LIMIT ${limit} OFFSET ${offset}
    `);
    const rows = res.rows as unknown as {
      sessionId: string;
      firstSeenAt: Date;
      lastSeenAt: Date;
      traceCount: number;
      costUsd: number;
      totalTokens: number;
      errorCount: number;
      evaluationsCount: number;
      firstMessageRaw: string | null;
    }[];
    const sessionsOut: SessionListItem[] = rows.map((r) => {
      const item: SessionListItem = {
        sessionId: r.sessionId,
        firstSeenAt: isoTimestamp(r.firstSeenAt),
        lastSeenAt: isoTimestamp(r.lastSeenAt),
        traceCount: r.traceCount,
        costUsd: round3(r.costUsd ?? 0),
        totalTokens: r.totalTokens ?? 0,
        errorRate: r.traceCount === 0 ? 0 : round3(r.errorCount / r.traceCount),
      };
      // EC-1: only surface a non-empty, non-whitespace first message.
      if (r.firstMessageRaw != null && r.firstMessageRaw.trim() !== "") {
        item.firstMessagePreview = preview(r.firstMessageRaw);
      }
      // M26d: per-session eval count (>0 → shown; 0 → omitted, no "0" column).
      if (r.evaluationsCount > 0) item.evaluationsCount = r.evaluationsCount;
      return item;
    });
    // M81: workspace-scoped total (one row per session — matches the GROUP BY grain).
    const totalRes = await this.db.execute(
      sql`SELECT count(*)::int AS n FROM sessions s WHERE s.workspace_id = ${workspaceId}`,
    );
    const total = (totalRes.rows[0] as { n: number } | undefined)?.n ?? 0;
    return { sessions: sessionsOut, total, limit, offset };
  }

  async getSessionDetail(
    sessionId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<SessionDetailResponse | null> {
    // Absent session → null (route 404). "Absent" = no row in the workspace's sessions.
    const sessionRows = await this.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.sessionId, sessionId),
          eq(sessions.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    const session = sessionRows[0];
    if (!session) return null;

    // Scoped aggregates over the member traces. count/cost/tokens cover ALL member
    // traces; the latency percentile FILTERs to numeric-bound traces only (M11 EC-1:
    // the cast runs only for filtered-in rows, so a NULL/garbage bound neither errors
    // nor counts as 0ms) and clamps clock skew via greatest(0, …).
    const aggRes = await this.db.execute(sql`
      SELECT count(*)::int AS "traceCount",
             coalesce(sum(cost_usd), 0)::double precision AS "costUsd",
             coalesce(sum(total_tokens), 0)::int AS "totalTokens",
             count(*) FILTER (WHERE status_code = 'error')::int AS "errorCount",
             percentile_cont(0.5) WITHIN GROUP (ORDER BY greatest(0, (end_time_unix_nano::numeric - start_time_unix_nano::numeric) / 1e6))
               FILTER (WHERE start_time_unix_nano ~ '^\\d+$' AND end_time_unix_nano ~ '^\\d+$')::double precision AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY greatest(0, (end_time_unix_nano::numeric - start_time_unix_nano::numeric) / 1e6))
               FILTER (WHERE start_time_unix_nano ~ '^\\d+$' AND end_time_unix_nano ~ '^\\d+$')::double precision AS p95
      FROM traces
      WHERE session_id = ${sessionId} AND workspace_id = ${workspaceId}
    `);
    const agg = (aggRes.rows as unknown as {
      traceCount: number;
      costUsd: number | null;
      totalTokens: number | null;
      errorCount: number;
      p50: number | null;
      p95: number | null;
    }[])[0]!;

    // Member traces as the stable list DTO (reuses the M3 mapping).
    const memberRows = await this.db
      .select()
      .from(traces)
      .where(
        and(
          eq(traces.sessionId, sessionId),
          eq(traces.workspaceId, workspaceId),
        ),
      )
      .orderBy(desc(traces.updatedAt));

    const raw: RawSessionDetail = {
      sessionId: session.sessionId,
      firstSeenAt: session.firstSeenAt,
      lastSeenAt: session.lastSeenAt,
      traceCount: agg.traceCount,
      costUsd: agg.costUsd,
      totalTokens: agg.totalTokens,
      errorCount: agg.errorCount,
      p50: agg.p50,
      p95: agg.p95,
      traces: memberRows.map(traceRowToItem),
    };
    return shapeSessionDetail(raw);
  }

  async addTag(
    traceId: string,
    tag: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<boolean> {
    // M14 (D2): you can only tag a real trace. Returns false → route 404 when the
    // trace does not exist. The insert is idempotent (UNIQUE(trace_id,tag) +
    // ON CONFLICT DO NOTHING) so a duplicate add is a harmless no-op.
    // NOTE: the existence check is advisory, not transactional — traces are
    // recompute-owned aggregates and never hard-deleted in this codebase, so the
    // SELECT→INSERT window is unreachable and an orphan tag row cannot occur. A
    // future trace-deletion path MUST revisit this (add a FK or a transaction).
    const existing = await this.db
      .select({ traceId: traces.traceId })
      .from(traces)
      .where(
        and(eq(traces.traceId, traceId), eq(traces.workspaceId, workspaceId)),
      )
      .limit(1);
    if (existing.length === 0) return false;
    await this.db
      .insert(traceTags)
      .values({ traceId, tag, workspaceId })
      .onConflictDoNothing({
        target: [traceTags.workspaceId, traceTags.traceId, traceTags.tag],
      });
    return true;
  }

  async removeTag(
    traceId: string,
    tag: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<void> {
    // Idempotent (D2): a no-op when the tag/trace is absent (within the workspace).
    await this.db
      .delete(traceTags)
      .where(
        and(
          eq(traceTags.traceId, traceId),
          eq(traceTags.tag, tag),
          eq(traceTags.workspaceId, workspaceId),
        ),
      );
  }

  async listTags(
    traceId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<string[]> {
    // Ordered for a stable UI / deterministic test (EC-6); empty when none.
    const rows = await this.db
      .select({ tag: traceTags.tag })
      .from(traceTags)
      .where(
        and(
          eq(traceTags.traceId, traceId),
          eq(traceTags.workspaceId, workspaceId),
        ),
      )
      .orderBy(asc(traceTags.tag));
    return rows.map((r) => r.tag);
  }

  async upsertAnnotation(
    traceId: string,
    ann: NormalizedAnnotation,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<boolean> {
    // M26b (D2): one annotation per (trace, span, name, annotatorKind) — re-submitting
    // REPLACES label/note/updatedAt (latest wins). `span_id = ''` sentinel = trace-level.
    // Advisory trace-exists check (like addTag) → false → route 404; same orphan-window
    // reasoning (traces are recompute-owned, never hard-deleted outside prune).
    const existing = await this.db
      .select({ traceId: traces.traceId })
      .from(traces)
      .where(
        and(eq(traces.traceId, traceId), eq(traces.workspaceId, workspaceId)),
      )
      .limit(1);
    if (existing.length === 0) return false;
    const spanId = ann.spanId ?? "";
    await this.db
      .insert(annotations)
      .values({
        workspaceId,
        traceId,
        spanId,
        name: ann.name,
        label: ann.label ?? null,
        note: ann.note ?? null,
        annotatorKind: ann.annotatorKind,
      })
      .onConflictDoUpdate({
        target: [
          annotations.workspaceId,
          annotations.traceId,
          annotations.spanId,
          annotations.name,
          annotations.annotatorKind,
        ],
        set: {
          label: ann.label ?? null,
          note: ann.note ?? null,
          updatedAt: sql`now()`,
        },
      });
    return true;
  }

  async listAnnotations(
    traceId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<Annotation[]> {
    // Newest-first (D2); trace-level (span_id '') + all spans'. Empty when none.
    const rows = await this.db
      .select()
      .from(annotations)
      .where(
        and(
          eq(annotations.traceId, traceId),
          eq(annotations.workspaceId, workspaceId),
        ),
      )
      .orderBy(desc(annotations.updatedAt));
    return rows.map((r) => ({
      // '' sentinel → trace-level: omit spanId so the DTO stays `.strict()` clean.
      ...(r.spanId !== "" ? { spanId: r.spanId } : {}),
      name: r.name,
      ...(r.label != null ? { label: r.label } : {}),
      ...(r.note != null ? { note: r.note } : {}),
      annotatorKind: r.annotatorKind,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  async removeAnnotation(
    traceId: string,
    key: { spanId?: string; name: string; annotatorKind?: string },
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<void> {
    // Idempotent (D2): a no-op when the annotation/trace is absent (in the workspace).
    await this.db
      .delete(annotations)
      .where(
        and(
          eq(annotations.traceId, traceId),
          eq(annotations.workspaceId, workspaceId),
          eq(annotations.spanId, key.spanId ?? ""),
          eq(annotations.name, key.name),
          eq(annotations.annotatorKind, key.annotatorKind ?? DEFAULT_ANNOTATOR_KIND),
        ),
      );
  }

  // ── M26d datasets ──────────────────────────────────────────────────────────

  /** Map a datasets row (+ item count) to the DTO. */
  private datasetRow(r: { id: string; name: string; createdAt: Date; itemCount: number }): Dataset {
    return {
      id: r.id,
      name: r.name,
      createdAt: isoTimestamp(r.createdAt),
      itemCount: r.itemCount,
    };
  }

  async createDataset(
    name: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<Dataset> {
    // D1: create-or-get on the workspace-leading UNIQUE (idempotent). Insert-or-
    // nothing, then read the row back (just-created or pre-existing) + item count.
    await this.db
      .insert(datasets)
      .values({ name, workspaceId })
      .onConflictDoNothing({ target: [datasets.workspaceId, datasets.name] });
    const rows = await this.db
      .select({
        id: datasets.id,
        name: datasets.name,
        createdAt: datasets.createdAt,
        itemCount: sql<number>`count(${datasetItems.id})::int`.as("item_count"),
      })
      .from(datasets)
      .leftJoin(
        datasetItems,
        and(
          eq(datasetItems.datasetId, datasets.id),
          eq(datasetItems.workspaceId, datasets.workspaceId),
        ),
      )
      .where(and(eq(datasets.name, name), eq(datasets.workspaceId, workspaceId)))
      .groupBy(datasets.id, datasets.name, datasets.createdAt)
      .limit(1);
    return this.datasetRow(rows[0]!);
  }

  async listDatasets(
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<Dataset[]> {
    // LEFT JOIN + GROUP BY for the per-dataset item count (a correlated subquery in
    // the projection did not correlate reliably here; the grouped join is idiomatic).
    const rows = await this.db
      .select({
        id: datasets.id,
        name: datasets.name,
        createdAt: datasets.createdAt,
        itemCount: sql<number>`count(${datasetItems.id})::int`.as("item_count"),
      })
      .from(datasets)
      .leftJoin(
        datasetItems,
        and(
          eq(datasetItems.datasetId, datasets.id),
          eq(datasetItems.workspaceId, datasets.workspaceId),
        ),
      )
      .where(eq(datasets.workspaceId, workspaceId))
      .groupBy(datasets.id, datasets.name, datasets.createdAt)
      .orderBy(desc(datasets.createdAt));
    return rows.map((r) => this.datasetRow(r));
  }

  async getDataset(
    datasetId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<DatasetDetail | null> {
    if (!isUuid(datasetId)) return null; // non-uuid path param → absent, not a 500
    const dsRows = await this.db
      .select()
      .from(datasets)
      .where(
        and(eq(datasets.id, datasetId), eq(datasets.workspaceId, workspaceId)),
      )
      .limit(1);
    const ds = dsRows[0];
    if (!ds) return null;
    const items = await this.db
      .select()
      .from(datasetItems)
      .where(
        and(
          eq(datasetItems.datasetId, datasetId),
          eq(datasetItems.workspaceId, workspaceId),
        ),
      )
      .orderBy(desc(datasetItems.createdAt));
    return {
      id: ds.id,
      name: ds.name,
      createdAt: isoTimestamp(ds.createdAt),
      items: items.map((i) => ({
        traceId: i.traceId,
        ...(i.inputSnapshot != null ? { inputSnapshot: i.inputSnapshot } : {}),
        ...(i.outputSnapshot != null ? { outputSnapshot: i.outputSnapshot } : {}),
        createdAt: isoTimestamp(i.createdAt),
      })),
    };
  }

  async addDatasetItem(
    datasetId: string,
    traceId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<boolean> {
    // D2/D3: snapshot the trace's root input/output AT ADD-TIME (durable past prune),
    // idempotent on (dataset, trace). Returns false if the dataset OR the trace is
    // absent in the workspace (→ 404) — advisory checks, like addTag/upsertAnnotation.
    if (!isUuid(datasetId)) return false;
    const ds = await this.db
      .select({ id: datasets.id })
      .from(datasets)
      .where(
        and(eq(datasets.id, datasetId), eq(datasets.workspaceId, workspaceId)),
      )
      .limit(1);
    if (ds.length === 0) return false;
    const tr = await this.db
      .select({ traceId: traces.traceId })
      .from(traces)
      .where(
        and(eq(traces.traceId, traceId), eq(traces.workspaceId, workspaceId)),
      )
      .limit(1);
    if (tr.length === 0) return false;
    // The root span (earliest, parent_span_id IS NULL) carries the trace's I/O.
    const root = await this.db
      .select({ input: spans.inputValue, output: spans.outputValue })
      .from(spans)
      .where(
        and(
          eq(spans.traceId, traceId),
          eq(spans.workspaceId, workspaceId),
          isNull(spans.parentSpanId),
        ),
      )
      .orderBy(asc(sql`${spans.startTimeUnixNano}::numeric`))
      .limit(1);
    const snap = root[0];
    await this.db
      .insert(datasetItems)
      .values({
        workspaceId,
        datasetId,
        traceId,
        inputSnapshot: snap?.input ?? null,
        outputSnapshot: snap?.output ?? null,
      })
      .onConflictDoNothing({
        target: [
          datasetItems.workspaceId,
          datasetItems.datasetId,
          datasetItems.traceId,
        ],
      });
    return true;
  }

  async addSyntheticDatasetItem(
    datasetId: string,
    input: string,
    output: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<boolean> {
    // M55: a synthetic item from a playground replay — input/output stored directly, sourced by a
    // generated `replay-{uuid}` id (NOT a real trace) so the item stays addressable (view + remove by
    // this id) and the unique index dedups correctly. Each save is a new example (fresh id). Returns
    // false if the dataset is absent in the workspace (→ 404). No source trace to snapshot from.
    if (!isUuid(datasetId)) return false;
    const ds = await this.db
      .select({ id: datasets.id })
      .from(datasets)
      .where(and(eq(datasets.id, datasetId), eq(datasets.workspaceId, workspaceId)))
      .limit(1);
    if (ds.length === 0) return false;
    await this.db.insert(datasetItems).values({
      workspaceId,
      datasetId,
      traceId: `replay-${randomUUID()}`,
      inputSnapshot: input,
      outputSnapshot: output,
    });
    return true;
  }

  async removeDatasetItem(
    datasetId: string,
    traceId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<void> {
    if (!isUuid(datasetId)) return; // idempotent: a non-uuid id removes nothing
    await this.db
      .delete(datasetItems)
      .where(
        and(
          eq(datasetItems.datasetId, datasetId),
          eq(datasetItems.traceId, traceId),
          eq(datasetItems.workspaceId, workspaceId),
        ),
      );
  }

  async renameDataset(
    datasetId: string,
    newName: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<Dataset | null> {
    if (!isUuid(datasetId)) return null; // non-uuid path param → absent, not a 500
    // UPDATE the name (workspace-scoped); a collision with another dataset's name violates the
    // (workspace_id, name) UNIQUE → surface as a typed NameConflictError (route maps to 409, M82 ADR-1).
    let updated: { id: string }[];
    try {
      updated = await this.db
        .update(datasets)
        .set({ name: newName })
        .where(and(eq(datasets.id, datasetId), eq(datasets.workspaceId, workspaceId)))
        .returning({ id: datasets.id });
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameConflictError("a dataset with that name already exists");
      throw err;
    }
    if (updated.length === 0) return null; // absent (or another workspace's dataset)
    // Read back the full DTO with itemCount (reuse the createDataset LEFT JOIN shape).
    const rows = await this.db
      .select({
        id: datasets.id,
        name: datasets.name,
        createdAt: datasets.createdAt,
        itemCount: sql<number>`count(${datasetItems.id})::int`.as("item_count"),
      })
      .from(datasets)
      .leftJoin(
        datasetItems,
        and(eq(datasetItems.datasetId, datasets.id), eq(datasetItems.workspaceId, datasets.workspaceId)),
      )
      .where(and(eq(datasets.id, datasetId), eq(datasets.workspaceId, workspaceId)))
      .groupBy(datasets.id, datasets.name, datasets.createdAt)
      .limit(1);
    return rows[0] ? this.datasetRow(rows[0]) : null;
  }

  async deleteDataset(
    datasetId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<boolean> {
    if (!isUuid(datasetId)) return false; // idempotent: a non-uuid id deletes nothing
    const exists = await this.db
      .select({ id: datasets.id })
      .from(datasets)
      .where(and(eq(datasets.id, datasetId), eq(datasets.workspaceId, workspaceId)))
      .limit(1);
    if (exists.length === 0) return false;
    // M82 ADR-2: cascade everything derived from the dataset in ONE transaction (no orphans, no FK):
    // the experiment runs' items → the experiment runs → the dataset items → the dataset. All workspace-scoped.
    await this.db.transaction(async (tx) => {
      const runIds = await tx
        .select({ id: experimentRuns.id })
        .from(experimentRuns)
        .where(and(eq(experimentRuns.datasetId, datasetId), eq(experimentRuns.workspaceId, workspaceId)));
      if (runIds.length > 0) {
        await tx
          .delete(experimentRunItems)
          .where(
            and(
              inArray(experimentRunItems.runId, runIds.map((r) => r.id)),
              eq(experimentRunItems.workspaceId, workspaceId),
            ),
          );
      }
      await tx
        .delete(experimentRuns)
        .where(and(eq(experimentRuns.datasetId, datasetId), eq(experimentRuns.workspaceId, workspaceId)));
      await tx
        .delete(datasetItems)
        .where(and(eq(datasetItems.datasetId, datasetId), eq(datasetItems.workspaceId, workspaceId)));
      await tx
        .delete(datasets)
        .where(and(eq(datasets.id, datasetId), eq(datasets.workspaceId, workspaceId)));
    });
    return true;
  }

  // ── M83 copilot answer feedback ──────────────────────────────────────────────

  async recordAskFeedback(
    traceId: string,
    input: AskFeedbackInput,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<CopilotFeedbackRecord> {
    // UPSERT on (workspace_id, trace_id, turn_id): a re-vote toggles the label (up↔down) in place,
    // never a duplicate row. Workspace-leading unique keeps a same-turn collision tenant-isolated.
    const rows = await this.db
      .insert(copilotFeedback)
      .values({
        workspaceId,
        traceId,
        turnId: input.turnId,
        spanId: input.spanId ?? "",
        label: input.label,
        question: input.question ?? null,
      })
      .onConflictDoUpdate({
        target: [copilotFeedback.workspaceId, copilotFeedback.traceId, copilotFeedback.turnId],
        set: { label: input.label, question: input.question ?? null, updatedAt: new Date() },
      })
      .returning();
    const r = rows[0]!;
    return {
      id: r.id,
      traceId: r.traceId,
      turnId: r.turnId,
      label: r.label as CopilotFeedbackRecord["label"],
      updatedAt: r.updatedAt.toISOString(),
      ...(r.spanId ? { spanId: r.spanId } : {}),
      ...(r.question != null ? { question: r.question } : {}),
    };
  }

  async deleteAskFeedback(
    traceId: string,
    turnId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<boolean> {
    // Retract the vote (the UI "clear"). Workspace-scoped; idempotent — no matching row → false.
    const deleted = await this.db
      .delete(copilotFeedback)
      .where(
        and(
          eq(copilotFeedback.workspaceId, workspaceId),
          eq(copilotFeedback.traceId, traceId),
          eq(copilotFeedback.turnId, turnId),
        ),
      )
      .returning({ id: copilotFeedback.id });
    return deleted.length > 0;
  }

  // ── M63 labeling queues ──────────────────────────────────────────────────────

  /** Map a labeling_queue_items row to the API DTO (nullable columns → optional/undefined). */
  private labelingItemRow(r: typeof labelingQueueItems.$inferSelect): LabelingQueueItem {
    return {
      id: r.id,
      traceId: r.traceId,
      spanId: r.spanId,
      status: r.status as LabelingQueueStatus,
      label: r.label ?? undefined,
      score: r.score ?? undefined,
      note: r.note ?? undefined,
      createdBy: r.createdBy,
      resolvedBy: r.resolvedBy ?? undefined,
      createdAt: r.createdAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString(),
    };
  }

  async enqueueLabelingItem(
    traceId: string,
    spanId: string,
    createdBy: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<LabelingQueueItem> {
    // Idempotent create-or-get on the workspace-leading PARTIAL unique (D1) — one PENDING item per
    // span. Insert-or-nothing (conflict only on a still-pending row), then read back the PENDING row
    // scoped to the workspace (a resolved row from an earlier review cycle is ignored).
    await this.db
      .insert(labelingQueueItems)
      .values({ traceId, spanId, createdBy, workspaceId })
      .onConflictDoNothing({
        target: [labelingQueueItems.workspaceId, labelingQueueItems.traceId, labelingQueueItems.spanId],
        where: sql`${labelingQueueItems.status} = 'pending'`,
      });
    const rows = await this.db
      .select()
      .from(labelingQueueItems)
      .where(
        and(
          eq(labelingQueueItems.workspaceId, workspaceId),
          eq(labelingQueueItems.traceId, traceId),
          eq(labelingQueueItems.spanId, spanId),
          eq(labelingQueueItems.status, "pending"),
        ),
      )
      .orderBy(desc(labelingQueueItems.createdAt))
      .limit(1);
    return this.labelingItemRow(rows[0]!);
  }

  async listLabelingQueue(
    opts: { status?: LabelingQueueStatus; page?: number; pageSize?: number },
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<LabelingQueuePage> {
    // Whitelisted pagination (bounded page size) + always workspace-scoped (never leaks cross-tenant).
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(opts.pageSize ?? 50)));
    const where = opts.status
      ? and(eq(labelingQueueItems.workspaceId, workspaceId), eq(labelingQueueItems.status, opts.status))
      : eq(labelingQueueItems.workspaceId, workspaceId);
    const totalRows = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(labelingQueueItems)
      .where(where);
    const rows = await this.db
      .select()
      .from(labelingQueueItems)
      .where(where)
      .orderBy(desc(labelingQueueItems.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return { items: rows.map((r) => this.labelingItemRow(r)), total: totalRows[0]?.n ?? 0, page, pageSize };
  }

  async getLabelingQueueItem(
    itemId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<LabelingQueueItem | null> {
    if (!isUuid(itemId)) return null; // non-uuid path param → absent, not a 500
    const rows = await this.db
      .select()
      .from(labelingQueueItems)
      .where(and(eq(labelingQueueItems.id, itemId), eq(labelingQueueItems.workspaceId, workspaceId)))
      .limit(1);
    return rows[0] ? this.labelingItemRow(rows[0]) : null;
  }

  async resolveLabelingItem(
    itemId: string,
    resolution: NormalizedResolution,
    resolvedBy: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<boolean> {
    if (!isUuid(itemId)) return false; // non-uuid → absent (→ 404), never a 500
    const updated = await this.db
      .update(labelingQueueItems)
      .set({
        status: "resolved",
        label: resolution.label,
        score: resolution.score ?? null,
        note: resolution.note ?? null,
        resolutionVersion: resolution.schemaVersion,
        resolvedBy,
        resolvedAt: new Date(),
      })
      .where(and(eq(labelingQueueItems.id, itemId), eq(labelingQueueItems.workspaceId, workspaceId)))
      .returning({ id: labelingQueueItems.id });
    return updated.length > 0; // false when absent / another workspace (→ 404)
  }

  async exportResolvedAsDataset(
    name: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<Dataset> {
    // Reuse the M44 dataset store (D4): create-or-get the named dataset, then add each RESOLVED item's
    // trace (idempotent). Every write is workspace-scoped — a golden dataset built from resolved reviews.
    const dataset = await this.createDataset(name, workspaceId);
    const resolved = await this.db
      .select({ traceId: labelingQueueItems.traceId })
      .from(labelingQueueItems)
      .where(and(eq(labelingQueueItems.workspaceId, workspaceId), eq(labelingQueueItems.status, "resolved")));
    for (const r of resolved) {
      await this.addDatasetItem(dataset.id, r.traceId, workspaceId);
    }
    // Re-read for the up-to-date item count.
    return (await this.listDatasets(workspaceId)).find((d) => d.id === dataset.id) ?? dataset;
  }

  // ── M64 experiment runs ──────────────────────────────────────────────────────

  /** Map an experiment_runs row to the API DTO (nullable columns → optional/undefined). */
  private experimentRunRow(r: typeof experimentRuns.$inferSelect, items?: ExperimentRunItem[]): ExperimentRun {
    return {
      id: r.id,
      datasetId: r.datasetId,
      name: r.name,
      variant: r.variant as RunVariant,
      status: r.status as RunStatus,
      truncated: r.truncated,
      itemCount: r.itemCount,
      passCount: r.passCount,
      avgScore: r.avgScore ?? undefined,
      totalCostUsd: r.totalCostUsd,
      createdBy: r.createdBy,
      createdAt: r.createdAt.toISOString(),
      ...(items ? { items } : {}),
    };
  }

  private experimentItemRow(r: typeof experimentRunItems.$inferSelect): ExperimentRunItem {
    return {
      datasetItemTraceId: r.datasetItemTraceId,
      inputSnapshot: r.inputSnapshot ?? undefined,
      output: r.output ?? undefined,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      totalTokens: r.totalTokens,
      costUsd: r.costUsd ?? undefined,
      latencyMs: r.latencyMs,
      model: r.model,
      scores: (r.scores as ExperimentRunItem["scores"]) ?? [],
      error: r.error ?? undefined,
    };
  }

  async createExperimentRun(
    run: {
      datasetId: string;
      name: string;
      variant: RunVariant;
      status: RunStatus;
      truncated: boolean;
      createdBy: string;
      items: ExperimentRunItem[];
    },
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<ExperimentRun> {
    // Compute aggregates from the engine's items (single source of truth) + persist run + items atomically.
    const agg = aggregateRun(run.items);
    const runId = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(experimentRuns)
        .values({
          workspaceId,
          datasetId: run.datasetId,
          name: run.name,
          variant: run.variant,
          status: run.status,
          truncated: run.truncated,
          itemCount: agg.itemCount,
          passCount: agg.passCount,
          avgScore: agg.avgScore ?? null,
          totalCostUsd: agg.totalCostUsd,
          createdBy: run.createdBy,
        })
        .returning({ id: experimentRuns.id });
      const id = inserted[0]!.id;
      if (run.items.length > 0) {
        await tx.insert(experimentRunItems).values(
          run.items.map((it) => ({
            workspaceId,
            runId: id,
            datasetItemTraceId: it.datasetItemTraceId,
            inputSnapshot: it.inputSnapshot ?? null,
            output: it.output ?? null,
            promptTokens: it.promptTokens,
            completionTokens: it.completionTokens,
            totalTokens: it.totalTokens,
            costUsd: it.costUsd ?? null,
            latencyMs: it.latencyMs,
            model: it.model,
            scores: it.scores,
            error: it.error ?? null,
          })),
        );
      }
      return id;
    });
    return (await this.getExperimentRun(runId, workspaceId))!;
  }

  async listExperimentRuns(
    datasetId: string | undefined,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<ExperimentRun[]> {
    const where =
      datasetId !== undefined
        ? and(eq(experimentRuns.workspaceId, workspaceId), eq(experimentRuns.datasetId, datasetId))
        : eq(experimentRuns.workspaceId, workspaceId);
    const rows = await this.db.select().from(experimentRuns).where(where).orderBy(desc(experimentRuns.createdAt));
    return rows.map((r) => this.experimentRunRow(r));
  }

  async getExperimentRun(
    runId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<ExperimentRun | null> {
    if (!isUuid(runId)) return null; // non-uuid path param → absent, not a 500
    const runs = await this.db
      .select()
      .from(experimentRuns)
      .where(and(eq(experimentRuns.id, runId), eq(experimentRuns.workspaceId, workspaceId)))
      .limit(1);
    if (!runs[0]) return null;
    const items = await this.db
      .select()
      .from(experimentRunItems)
      .where(and(eq(experimentRunItems.runId, runId), eq(experimentRunItems.workspaceId, workspaceId)))
      .orderBy(asc(experimentRunItems.createdAt));
    return this.experimentRunRow(runs[0], items.map((it) => this.experimentItemRow(it)));
  }

  async aggregateAgents(
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
    const res = await this.db.execute(sql`
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
    const rows = res.rows as unknown as {
      name: string;
      first_seen: Date;
      last_seen: Date;
      run_count: number;
      versions: string[] | null;
      system_prompt: string | null;
      tools: string[] | null;
    }[];
    const now = new Date();
    return rows.map((r): Agent => {
      const raw: RawAgent = {
        name: r.name,
        firstSeenAt: isoTimestamp(r.first_seen),
        latestSeenAt: isoTimestamp(r.last_seen),
        runCount: r.run_count,
        versions: r.versions ?? [],
        tools: r.tools ?? [],
        systemPrompt: r.system_prompt,
      };
      return shapeAgent(raw, { now });
    });
  }

  async prune(olderThan: Date): Promise<PruneStats> {
    // M23 trace-granular hard-delete cascade, atomic in one transaction (the
    // tables have NO DB foreign keys — see the orphan-risk note on listTags — so
    // each dependent table is cleaned explicitly). Order: delete spans/tags/replay
    // of stale traces FIRST (the `stale` subquery reads `traces` while it still
    // holds those rows), THEN the stale traces, THEN now-orphaned sessions.
    const cutoff = olderThan.toISOString();
    const rowCount = (r: { rowCount: number | null }): number => r.rowCount ?? 0;
    return this.db.transaction(async (tx) => {
      // M22: trace_id is no longer globally unique (composite PK (workspace_id,
      // trace_id)). The stale set is keyed by BOTH columns so a stale trace in one
      // workspace never cascades a delete onto a same-trace_id row in another
      // workspace (row-value IN over the pair). Retention itself stays system-wide
      // (age-based operator policy) — only the cascade is workspace-precise.
      const stale = sql`(SELECT workspace_id, trace_id FROM traces WHERE updated_at < ${cutoff})`;
      const spansRes = await tx.execute(
        sql`DELETE FROM spans WHERE (workspace_id, trace_id) IN ${stale}`,
      );
      const tagsRes = await tx.execute(
        sql`DELETE FROM trace_tags WHERE (workspace_id, trace_id) IN ${stale}`,
      );
      const replayRes = await tx.execute(
        sql`DELETE FROM replay_sessions WHERE (workspace_id, trace_id) IN ${stale}`,
      );
      // M26: eval rows of stale traces (avoid orphan span_evaluations). M26b: human
      // annotations of stale traces. Both keyed by (workspace_id, trace_id), no FK.
      const evalsRes = await tx.execute(
        sql`DELETE FROM span_evaluations WHERE (workspace_id, trace_id) IN ${stale}`,
      );
      const annotationsRes = await tx.execute(
        sql`DELETE FROM annotations WHERE (workspace_id, trace_id) IN ${stale}`,
      );
      const tracesRes = await tx.execute(
        sql`DELETE FROM traces WHERE updated_at < ${cutoff}`,
      );
      // EC-1: the `IS NOT NULL` guard is mandatory — a NULL in a NOT IN set makes
      // the whole predicate UNKNOWN and would silently delete ZERO orphans. The pair
      // (workspace_id, session_id) matches the composite sessions PK so a live
      // session in workspace B is never orphan-deleted by workspace A's traces.
      const sessionsRes = await tx.execute(
        sql`DELETE FROM sessions WHERE (workspace_id, session_id) NOT IN (SELECT workspace_id, session_id FROM traces WHERE session_id IS NOT NULL)`,
      );
      return {
        cutoff,
        spansDeleted: rowCount(spansRes),
        tagsDeleted: rowCount(tagsRes),
        replaySessionsDeleted: rowCount(replayRes),
        tracesDeleted: rowCount(tracesRes),
        sessionsDeleted: rowCount(sessionsRes),
        evaluationsDeleted: rowCount(evalsRes),
        annotationsDeleted: rowCount(annotationsRes),
      };
    });
  }
}

export function createSpanRepository(connectionString: string): {
  repo: DrizzleSpanRepository;
  pool: pg.Pool;
} {
  const pool = createPool(connectionString);
  const db = drizzle(pool);
  return { repo: new DrizzleSpanRepository(db), pool };
}

const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations", import.meta.url));

/** Apply the committed Drizzle migrations (the real release artifact) to `pool`. */
export async function migrateLatest(pool: pg.Pool): Promise<void> {
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_DIR });
}
