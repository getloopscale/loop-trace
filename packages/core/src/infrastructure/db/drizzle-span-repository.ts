import { fileURLToPath } from "node:url";
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNull, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import type { Span } from "../../domain/span.js";
import { DEFAULT_WORKSPACE_ID } from "../../domain/principal.js";
import {
  LATENCY_MS_EXPR,
  DERIVED_AGENT_NAME_SQL,
  spanClauseSql,
  toRow,
  fromRow,
  traceRowToItem,
} from "./repo-shared.js";
import * as annotationRepo from "./annotation-repository.js";
import * as retentionRepo from "./retention-repository.js";
import * as sessionRepo from "./session-repository.js";
import * as copilotFeedbackRepo from "./copilot-feedback-repository.js";
import * as experimentRepo from "./experiment-repository.js";
import * as datasetRepo from "./dataset-repository.js";
import * as labelingRepo from "./labeling-queue-repository.js";
import type { AskFeedbackInput, CopilotFeedbackRecord } from "../../domain/copilot-feedback.js";
import type {
  SpanRepository,
  TraceTreeNode,
} from "../../domain/span-repository.js";
import type {
  ListTracesOptions,
  TraceListResponse,
} from "../../domain/trace-list.js";
import type {
  LabelingQueueItem,
  LabelingQueuePage,
  LabelingQueueStatus,
  NormalizedResolution,
} from "../../domain/labeling-queue.js";
import type { ExperimentRun } from "../../domain/experiment.js";
import { computeTraceCost, type PriceTable } from "../../domain/pricing.js";
import { DEFAULT_PRICES } from "../../domain/default-prices.js";
import type {
  CostByPeriodResponse,
  CostPeriod,
  TraceCost,
} from "../../domain/cost.js";
import { round3, ERROR_STATUS_CODES, type ToolStatsResponse } from "../../domain/tool-stats.js";
import { parsePoolConfig, type PoolConfig } from "../../domain/evaluator-config.js";
import {
  shapeNorthStarBuckets,
  bucketRowSchema,
  type NorthStarResponse,
} from "../../domain/north-star.js";
import { rowsAs } from "../../domain/sql-rows.js";
import {
  shapeObservability,
  RANGE_BUCKETS,
  type ObservabilityRange,
  type ObservabilityResponse,
  type RawObservability,
} from "../../domain/observability.js";
import {
  isoTimestamp,
  type SessionListResponse,
  type SessionDetailResponse,
} from "../../domain/session.js";
import type { PruneStats } from "../../domain/retention.js";
import { parseSpanQuery } from "../../domain/span-query.js";
import type { EvaluatorSummary, ScoreBucket } from "../../domain/evaluation.js";
import type { SpanAttributeKey, SpanAttributeValue } from "../../domain/span-facets.js";
import { spans, traces, replaySessions, traceTags, spanEvaluations } from "./schema.js";
import type { Annotation, NormalizedAnnotation } from "../../domain/annotation.js";
import type { Dataset, DatasetDetail } from "../../domain/dataset.js";
import { shapeAgent, type Agent, type RawAgent } from "../../domain/agent-catalog.js";

/** Build a pg connection pool for the given Postgres URI. M94: the pool carries resilience config
 *  (max + connect/idle/statement/query timeouts) so a stuck query self-aborts and frees its
 *  connection, and a burst cannot exhaust DB connections. Defaults from `parsePoolConfig` (env-tunable). */
export function createPool(connectionString: string, config: PoolConfig = parsePoolConfig()): pg.Pool {
  const pool = new pg.Pool({ connectionString, ...config });
  // M94 — an idle-client error (e.g. Postgres restarts / the network drops) emits a pool `error`
  // event; WITHOUT a handler, node-pg re-throws it as an uncaught exception and CRASHES the process.
  // We log it and let the pool evict the dead client — so a DB outage degrades to /ready 503 with the
  // process ALIVE (the whole point of the readiness probe), never a crash. (Caught by the M94 live-smoke.)
  pool.on("error", (err) => {
    console.error(
      JSON.stringify({ level: "error", msg: "pg pool idle-client error (non-fatal)", error: err.message }),
    );
  });
  return pool;
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
      // M97 (B-L1) — validate the raw bucket rows at the SQL→DTO boundary; a renamed
      // `date_trunc`/`count` alias now throws loudly here instead of shaping `undefined`.
      tracesPerDay: shapeNorthStarBuckets(rowsAs(tracesRes, bucketRowSchema, "northStar.tracesPerDay")),
      replaySessionsPerWeek: shapeNorthStarBuckets(
        rowsAs(sessionsRes, bucketRowSchema, "northStar.replaySessionsPerWeek"),
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
             percentile_cont(0.5)  WITHIN GROUP (ORDER BY ${sql.raw(LATENCY_MS_EXPR)})::double precision AS p50,
             percentile_cont(0.75) WITHIN GROUP (ORDER BY ${sql.raw(LATENCY_MS_EXPR)})::double precision AS p75,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY ${sql.raw(LATENCY_MS_EXPR)})::double precision AS p95,
             percentile_cont(0.99) WITHIN GROUP (ORDER BY ${sql.raw(LATENCY_MS_EXPR)})::double precision AS p99
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

  async aggregateScoresOverTime(
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
    const summaryRes = await this.db.execute(sql`
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
    const labelRes = await this.db.execute(sql`
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
        labels: labelsByCell.get(`${periodStart}|${r.name}`) ?? {},
      };
    });
  }

  // M92 — facet discovery over the spans.attributes jsonb bag. Capped: a recent 30-day window +
  // top-N by frequency (the suggest control needs a hint, not an exhaustive index — ADR-3). Every
  // query is workspace-scoped. The `key` in values-mode is a BOUND jsonb path (injection-safe).
  private static readonly FACET_WINDOW = sql.raw("interval '30 days'");
  private static readonly FACET_LIMIT = 50;

  async discoverSpanAttributeKeys(
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<SpanAttributeKey[]> {
    const res = await this.db.execute(sql`
      SELECT key, count(*)::int AS count
      FROM (
        SELECT jsonb_object_keys(attributes) AS key
        FROM spans
        WHERE workspace_id = ${workspaceId}
          AND attributes IS NOT NULL
          AND ingested_at >= now() - ${DrizzleSpanRepository.FACET_WINDOW}
      ) k
      GROUP BY key
      ORDER BY count DESC, key ASC
      LIMIT ${DrizzleSpanRepository.FACET_LIMIT}
    `);
    return (res.rows as { key: string; count: number }[]).map((r) => ({
      key: r.key,
      count: Number(r.count),
    }));
  }

  async discoverSpanAttributeValues(
    key: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<SpanAttributeValue[]> {
    // The KEY is bound as a jsonb path operand (data, never SQL) — same injection-safety as `attr:`.
    const res = await this.db.execute(sql`
      SELECT value, count(*)::int AS count
      FROM (
        SELECT attributes->>${key} AS value
        FROM spans
        WHERE workspace_id = ${workspaceId}
          AND ingested_at >= now() - ${DrizzleSpanRepository.FACET_WINDOW}
      ) v
      WHERE value IS NOT NULL
      GROUP BY value
      ORDER BY count DESC, value ASC
      LIMIT ${DrizzleSpanRepository.FACET_LIMIT}
    `);
    return (res.rows as { value: string; count: number }[]).map((r) => ({
      value: r.value,
      count: Number(r.count),
    }));
  }

  // M99 (B-M1) — the SessionRepository role now lives in `session-repository.ts`.
  listSessions(workspaceId: string = DEFAULT_WORKSPACE_ID, opts: { limit?: number; offset?: number } = {}): Promise<SessionListResponse> {
    return sessionRepo.listSessions(this.db, workspaceId, opts);
  }

  getSessionDetail(sessionId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<SessionDetailResponse | null> {
    return sessionRepo.getSessionDetail(this.db, sessionId, workspaceId);
  }

  // M99 (B-M1) — the AnnotationRepository role now lives in `annotation-repository.ts`; the facade
  // delegates over the shared `db` handle. Behavior unchanged (SQL moved verbatim).
  addTag(traceId: string, tag: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<boolean> {
    return annotationRepo.addTag(this.db, traceId, tag, workspaceId);
  }

  removeTag(traceId: string, tag: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<void> {
    return annotationRepo.removeTag(this.db, traceId, tag, workspaceId);
  }

  listTags(traceId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<string[]> {
    return annotationRepo.listTags(this.db, traceId, workspaceId);
  }

  upsertAnnotation(traceId: string, ann: NormalizedAnnotation, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<boolean> {
    return annotationRepo.upsertAnnotation(this.db, traceId, ann, workspaceId);
  }

  listAnnotations(traceId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<Annotation[]> {
    return annotationRepo.listAnnotations(this.db, traceId, workspaceId);
  }

  removeAnnotation(
    traceId: string,
    key: { spanId?: string; name: string; annotatorKind?: string },
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<void> {
    return annotationRepo.removeAnnotation(this.db, traceId, key, workspaceId);
  }

  // ── M26d datasets ──────────────────────────────────────────────────────────

  /** Map a datasets row (+ item count) to the DTO. */
  // M97 (B-M1) — the DatasetRepository role now lives in `dataset-repository.ts`; the facade
  // delegates over the shared `db` handle. Behavior unchanged (the SQL/shaping moved verbatim).
  createDataset(name: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<Dataset> {
    return datasetRepo.createDataset(this.db, name, workspaceId);
  }

  listDatasets(workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<Dataset[]> {
    return datasetRepo.listDatasets(this.db, workspaceId);
  }

  getDataset(datasetId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<DatasetDetail | null> {
    return datasetRepo.getDataset(this.db, datasetId, workspaceId);
  }

  addDatasetItem(datasetId: string, traceId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<boolean> {
    return datasetRepo.addDatasetItem(this.db, datasetId, traceId, workspaceId);
  }

  addSyntheticDatasetItem(
    datasetId: string,
    input: string,
    output: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<boolean> {
    return datasetRepo.addSyntheticDatasetItem(this.db, datasetId, input, output, workspaceId);
  }

  removeDatasetItem(datasetId: string, traceId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<void> {
    return datasetRepo.removeDatasetItem(this.db, datasetId, traceId, workspaceId);
  }

  renameDataset(datasetId: string, newName: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<Dataset | null> {
    return datasetRepo.renameDataset(this.db, datasetId, newName, workspaceId);
  }

  deleteDataset(datasetId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<boolean> {
    return datasetRepo.deleteDataset(this.db, datasetId, workspaceId);
  }

  // ── M83 copilot answer feedback ──────────────────────────────────────────────

  // M99 (B-M1) — the CopilotFeedbackRepository role now lives in `copilot-feedback-repository.ts`.
  recordAskFeedback(traceId: string, input: AskFeedbackInput, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<CopilotFeedbackRecord> {
    return copilotFeedbackRepo.recordAskFeedback(this.db, traceId, input, workspaceId);
  }

  deleteAskFeedback(traceId: string, turnId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<boolean> {
    return copilotFeedbackRepo.deleteAskFeedback(this.db, traceId, turnId, workspaceId);
  }

  // ── M63 labeling queues ──────────────────────────────────────────────────────

  /** Map a labeling_queue_items row to the API DTO (nullable columns → optional/undefined). */
  // M97 (B-M1) — the LabelingQueueRepository role now lives in `labeling-queue-repository.ts`; the
  // facade delegates over the shared `db` handle. Behavior unchanged (SQL/shaping moved verbatim).
  enqueueLabelingItem(
    traceId: string,
    spanId: string,
    createdBy: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<LabelingQueueItem> {
    return labelingRepo.enqueueLabelingItem(this.db, traceId, spanId, createdBy, workspaceId);
  }

  listLabelingQueue(
    opts: { status?: LabelingQueueStatus; page?: number; pageSize?: number },
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<LabelingQueuePage> {
    return labelingRepo.listLabelingQueue(this.db, opts, workspaceId);
  }

  getLabelingQueueItem(itemId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<LabelingQueueItem | null> {
    return labelingRepo.getLabelingQueueItem(this.db, itemId, workspaceId);
  }

  resolveLabelingItem(
    itemId: string,
    resolution: NormalizedResolution,
    resolvedBy: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<boolean> {
    return labelingRepo.resolveLabelingItem(this.db, itemId, resolution, resolvedBy, workspaceId);
  }

  exportResolvedAsDataset(name: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<Dataset> {
    return labelingRepo.exportResolvedAsDataset(this.db, name, workspaceId);
  }

  // ── M64 experiment runs ──────────────────────────────────────────────────────

  /** Map an experiment_runs row to the API DTO (nullable columns → optional/undefined). */
  // M97 (B-M1) — the ExperimentRepository role now lives in `experiment-repository.ts`; the facade
  // delegates over the shared `db` handle. Behavior unchanged (the SQL/shaping moved verbatim).
  createExperimentRun(
    run: Parameters<typeof experimentRepo.createExperimentRun>[1],
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<ExperimentRun> {
    return experimentRepo.createExperimentRun(this.db, run, workspaceId);
  }

  listExperimentRuns(
    datasetId: string | undefined,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<ExperimentRun[]> {
    return experimentRepo.listExperimentRuns(this.db, datasetId, workspaceId);
  }

  getExperimentRun(runId: string, workspaceId: string = DEFAULT_WORKSPACE_ID): Promise<ExperimentRun | null> {
    return experimentRepo.getExperimentRun(this.db, runId, workspaceId);
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

  // M99 (B-M1) — the RetentionRepository role now lives in `retention-repository.ts`.
  prune(olderThan: Date): Promise<PruneStats> {
    return retentionRepo.prune(this.db, olderThan);
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
