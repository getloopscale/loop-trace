import { fileURLToPath } from "node:url";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import type { Span } from "../../domain/span.js";
import type {
  SpanRepository,
  TraceTreeNode,
} from "../../domain/span-repository.js";
import type {
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
import { spans, traces, replaySessions } from "./schema.js";

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
function traceRowToItem(row: typeof traces.$inferSelect): TraceListItem {
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
        await tx.execute(sql`
          INSERT INTO traces (trace_id, session_id, name, start_time_unix_nano, end_time_unix_nano, input_tokens, output_tokens, total_tokens, cost_usd, updated_at)
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

  async listTraces(limit = 50): Promise<TraceListResponse> {
    // Newest-active first (the traces aggregate stamps updated_at on each
    // recompute). Maps rows → strict DTO so no Drizzle column leaks (D2).
    const rows = await this.db
      .select()
      .from(traces)
      .orderBy(desc(traces.updatedAt))
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
