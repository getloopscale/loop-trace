import { fileURLToPath } from "node:url";
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import type { Span } from "../../domain/span.js";
import type {
  SpanRepository,
  TraceTreeNode,
} from "../../domain/span-repository.js";
import type {
  ListTracesOptions,
  TraceListItem,
  TraceListResponse,
} from "../../domain/trace-list.js";
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
import { spans, traces, sessions, replaySessions, traceTags } from "./schema.js";

/** Build a pg connection pool for the given Postgres URI. */
export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

type SpanRow = typeof spans.$inferInsert;

function toRow(span: Span): SpanRow {
  return {
    spanId: span.spanId,
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
}

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
  return item;
}

export class DrizzleSpanRepository implements SpanRepository {
  constructor(
    private readonly db: NodePgDatabase,
    // Configurable per-model price table (M5 ADR D1 — injectable for risk #1).
    private readonly priceTable: PriceTable = DEFAULT_PRICES,
  ) {}

  async save(spansToSave: Span[]): Promise<void> {
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
        .values(unique.map(toRow))
        .onConflictDoNothing({ target: spans.spanId });

      // Recompute each affected trace's aggregate FROM the spans table (idempotent
      // under retry + race-safe — ADR D3 / EC-1). Never an incremental sum.
      for (const traceId of traceIds) {
        // Serialize concurrent ingests of the SAME trace so each recompute sees
        // all prior-committed spans (READ COMMITTED recompute alone undercounts
        // under interleaving). pg_advisory_xact_lock releases at commit.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${traceId}))`,
        );
        // Trace-level status = 'error' if ANY span errored (error propagates from
        // child to parent — Phoenix convention), else 'ok'. This populates the
        // previously-unset traces.status_code so the list can surface + filter it
        // (M9); error tokens are the same constant the UI/tool-stats use.
        const errorList = ERROR_STATUS_CODES.map((c) => `'${c}'`).join(", ");
        await tx.execute(sql`
          INSERT INTO traces (trace_id, session_id, name, start_time_unix_nano, end_time_unix_nano, input_tokens, output_tokens, total_tokens, cost_usd, status_code, updated_at)
          SELECT
            ${traceId},
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
          FROM spans WHERE trace_id = ${traceId}
          ON CONFLICT (trace_id) DO UPDATE SET
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
          FROM spans WHERE trace_id = ${traceId} AND model IS NOT NULL
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
          sql`UPDATE traces SET cost_usd = ${cost} WHERE trace_id = ${traceId}`,
        );
      }

      for (const sessionId of sessionIds) {
        await tx.execute(sql`
          INSERT INTO sessions (session_id, first_seen_at, last_seen_at)
          VALUES (${sessionId}, now(), now())
          ON CONFLICT (session_id) DO UPDATE SET last_seen_at = now()
        `);
      }
    });
  }

  async getBySpanId(spanId: string): Promise<Span | null> {
    const rows = await this.db
      .select()
      .from(spans)
      .where(eq(spans.spanId, spanId))
      .limit(1);
    const row = rows[0];
    return row ? fromRow(row) : null;
  }

  async getTraceTree(traceId: string): Promise<TraceTreeNode | null> {
    // Deterministic sibling order at the source: numeric start time, then spanId
    // (the PK — a stable total order). Makes the persisted tree reproducible across
    // fetches and aligns the rendered tree with the replay step order (review F-rp-1).
    const rows = await this.db
      .select()
      .from(spans)
      .where(eq(spans.traceId, traceId))
      .orderBy(sql`start_time_unix_nano::numeric`, spans.spanId);
    if (rows.length === 0) return null;

    // Read-time assembly over ALL persisted spans → out-of-order batches and
    // orphans (parent absent) resolve correctly (EC-2 / Q3).
    const nodes = new Map<string, TraceTreeNode>();
    for (const r of rows) nodes.set(r.spanId, { ...fromRow(r), children: [] });
    const all = [...nodes.values()];

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

  async listTraces(opts: ListTracesOptions = {}): Promise<TraceListResponse> {
    // M9: whitelisted filter (status/model/time) + sort (recent/latency/tokens/
    // cost, dir) + bounded limit. No opts → newest-50 by updated_at (legacy).
    // Maps rows → strict DTO so no Drizzle column leaks (M3 D2).
    const conds = [];
    if (opts.from) conds.push(gte(traces.updatedAt, new Date(opts.from)));
    if (opts.to) conds.push(lte(traces.updatedAt, new Date(opts.to)));
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
        .where(eq(spans.model, opts.model));
      conds.push(inArray(traces.traceId, modelTraceIds));
    }
    if (opts.tag) {
      // M14: same selectDistinct + inArray subquery as the model filter — composes
      // with the other conds without changing the row shape traceRowToItem expects.
      const taggedTraceIds = this.db
        .selectDistinct({ traceId: traceTags.traceId })
        .from(traceTags)
        .where(eq(traceTags.tag, opts.tag));
      conds.push(inArray(traces.traceId, taggedTraceIds));
    }
    const where = conds.length > 0 ? and(...conds) : undefined;

    // EC-2: latency sorts on the nullable TEXT nanos via a numeric cast, clamping
    // clock-skew negatives to 0 (M6 consistency); NULLS LAST so missing values
    // never lead; secondary updated_at DESC makes ties deterministic (Q1).
    const sortCol =
      opts.orderBy === "latency"
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
        toolName: sql<
          string | null
        >`${spans.attributes}->>'gen_ai.tool.name'`.as("tool_name"),
        inputValue: spans.inputValue,
        outputValue: spans.outputValue,
      })
      .from(spans)
      .where(and(eq(spans.traceId, traces.traceId), isNull(spans.parentSpanId)))
      .orderBy(asc(sql`${spans.startTimeUnixNano}::numeric`))
      .limit(1)
      .as("root");

    const rows = await this.db
      .select({
        ...getTableColumns(traces),
        rootModel: root.model,
        rootOperationName: root.operationName,
        rootToolName: root.toolName,
        rootInputValue: root.inputValue,
        rootOutputValue: root.outputValue,
      })
      .from(traces)
      .leftJoinLateral(root, sql`true`)
      .where(where)
      .orderBy(sql`${sortCol} ${dir} nulls last`, desc(traces.updatedAt))
      .limit(limit);
    return { traces: rows.map(traceRowToItem) };
  }

  async getTraceCost(traceId: string): Promise<TraceCost | null> {
    const rows = await this.db
      .select()
      .from(traces)
      .where(eq(traces.traceId, traceId))
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
      WHERE updated_at >= now() - interval '90 days'
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

  async aggregateToolStats(): Promise<ToolStatsResponse> {
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
      WHERE tool_name IS NOT NULL AND ingested_at >= now() - interval '90 days'
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
          gte(spans.ingestedAt, sql`now() - interval '90 days'`),
        ),
      );
    const rows = await this.db
      .select()
      .from(traces)
      .where(inArray(traces.traceId, callingTraceIds))
      .orderBy(desc(traces.updatedAt))
      .limit(limit);
    return { traces: rows.map(traceRowToItem) };
  }

  async recordReplaySession(traceId: string): Promise<void> {
    // One row per replay opened in the UI — the sole data source for the
    // "replay sessions per week" north-star (replay is otherwise client-only).
    await this.db.insert(replaySessions).values({ traceId });
  }

  async aggregateNorthStar(): Promise<NorthStarResponse> {
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
      WHERE ingested_at >= now() - interval '30 days'
      GROUP BY bucket
      ORDER BY bucket DESC
    `);
    const sessionsRes = await this.db.execute(sql`
      SELECT date_trunc('week', opened_at) AS bucket,
             count(*)::int AS count
      FROM replay_sessions
      WHERE opened_at >= now() - interval '12 weeks'
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
      WHERE updated_at >= now() - ${sql.raw(`interval '${interval}'`)}
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
      WHERE updated_at >= now() - ${sql.raw(`interval '${interval}'`)}
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
        AND model IS NOT NULL
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

  async listSessions(): Promise<SessionListResponse> {
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
             (SELECT sp.input_value
                FROM spans sp
                JOIN traces tt ON tt.trace_id = sp.trace_id
               WHERE tt.session_id = s.session_id
                 AND sp.parent_span_id IS NULL
                 AND sp.start_time_unix_nano ~ '^\\d+$'
               ORDER BY sp.start_time_unix_nano::numeric ASC
               LIMIT 1) AS "firstMessageRaw"
      FROM sessions s
      LEFT JOIN traces t ON t.session_id = s.session_id
      GROUP BY s.session_id, s.first_seen_at, s.last_seen_at
      ORDER BY s.last_seen_at DESC, s.session_id DESC
    `);
    const rows = res.rows as unknown as {
      sessionId: string;
      firstSeenAt: Date;
      lastSeenAt: Date;
      traceCount: number;
      costUsd: number;
      totalTokens: number;
      errorCount: number;
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
      return item;
    });
    return { sessions: sessionsOut };
  }

  async getSessionDetail(sessionId: string): Promise<SessionDetailResponse | null> {
    // Absent session → null (route 404). "Absent" = no row in the sessions table.
    const sessionRows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.sessionId, sessionId))
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
      WHERE session_id = ${sessionId}
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
      .where(eq(traces.sessionId, sessionId))
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

  async addTag(traceId: string, tag: string): Promise<boolean> {
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
      .where(eq(traces.traceId, traceId))
      .limit(1);
    if (existing.length === 0) return false;
    await this.db
      .insert(traceTags)
      .values({ traceId, tag })
      .onConflictDoNothing({
        target: [traceTags.traceId, traceTags.tag],
      });
    return true;
  }

  async removeTag(traceId: string, tag: string): Promise<void> {
    // Idempotent (D2): a no-op when the tag/trace is absent.
    await this.db
      .delete(traceTags)
      .where(and(eq(traceTags.traceId, traceId), eq(traceTags.tag, tag)));
  }

  async listTags(traceId: string): Promise<string[]> {
    // Ordered for a stable UI / deterministic test (EC-6); empty when none.
    const rows = await this.db
      .select({ tag: traceTags.tag })
      .from(traceTags)
      .where(eq(traceTags.traceId, traceId))
      .orderBy(asc(traceTags.tag));
    return rows.map((r) => r.tag);
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
