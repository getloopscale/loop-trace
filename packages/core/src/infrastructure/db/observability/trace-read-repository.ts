/**
 * M99 (audit B-M1) — the TraceReadRepository role (ingest + point reads + the M9 list DSL), extracted
 * from the god-adapter into its own file. Pure functions over the shared Drizzle `db` handle; the
 * facade delegates. Behavior-preserving: the SQL/shaping moved verbatim; the trace integration tests
 * are the proof. Imports are pruned to what the methods use.
 */
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNull, lte, or, notInArray, sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { DEFAULT_WORKSPACE_ID } from "../../../domain/principal.js";
import { ERROR_STATUS_CODES } from "../../../domain/observability/tool-stats.js";
import { computeTraceCost, type PriceTable } from "../../../domain/observability/pricing.js";
import { parseSpanQuery } from "../../../domain/observability/span-query.js";
import type { Span } from "../../../domain/observability/span.js";
import type { ListTracesOptions, TraceListResponse } from "../../../domain/observability/trace-list.js";
import type { TraceCost } from "../../../domain/observability/cost.js";
import type { TraceTreeNode } from "../../../domain/observability/span-repository.js";
import { spans, traces, traceTags, spanEvaluations } from "../schema.js";
import { spanClauseSql, toRow, fromRow, traceRowToItem } from "../repo-shared.js";

export async function save(
  db: NodePgDatabase,
  priceTable: PriceTable,
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

  await db.transaction(async (tx) => {
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
      // child to parent — the common error-propagation convention), else 'ok'. This populates the
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
        -- #52: guard against a phantom rollup. When the span INSERT above was skipped by
        -- ON CONFLICT (workspace_id, span_id) DO NOTHING (a span_id re-ingested under a new
        -- trace_id), zero spans match here; without this HAVING the aggregate still yields one
        -- all-NULL row and would insert a spans-less traces row that 404s on GET /v1/traces/:id.
        HAVING count(*) > 0
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
        priceTable,
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


export async function getBySpanId(
  db: NodePgDatabase,
  spanId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<Span | null> {
  const rows = await db
    .select()
    .from(spans)
    .where(and(eq(spans.spanId, spanId), eq(spans.workspaceId, workspaceId)))
    .limit(1);
  const row = rows[0];
  return row ? fromRow(row) : null;
}


export async function getTraceTree(
  db: NodePgDatabase,
  traceId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<TraceTreeNode | null> {
  // Deterministic sibling order at the source: numeric start time, then spanId
  // (the PK — a stable total order). Makes the persisted tree reproducible across
  // fetches and aligns the rendered tree with the replay step order (review F-rp-1).
  // M22: scoped by workspace — a trace's spans never cross the tenant boundary.
  const rows = await db
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
  const evalRows = await db
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


export async function listTraces(
  db: NodePgDatabase,
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
    const modelTraceIds = db
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
    const taggedTraceIds = db
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
  const root = db
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
  // I/O (the demo fixture, unchanged), else the earliest span in the trace with a
  // non-null input/output. A Claude Code trace's root is `claude_code.llm_request`
  // (no I/O); its first `claude_code.tool` child carries the command + result.
  // Kind stays root-derived (above); only the I/O sourcing differs.
  const repr = db
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

  const rows = await db
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
  const totalRows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(traces)
    .where(where);
  return { traces: rows.map(traceRowToItem), total: totalRows[0]?.n ?? 0, limit, offset };
}


export async function getTraceCost(
  db: NodePgDatabase,
  traceId: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<TraceCost | null> {
  const rows = await db
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


export async function listTracesForTool(
  db: NodePgDatabase,
  toolName: string,
  limit = 50,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): Promise<TraceListResponse> {
  // Drill-down (M6): executions whose spans include this tool, newest-active first.
  // Reuses the M3 TraceListResponse DTO (no new shape). Uses the query builder so
  // rows map to the camelCase row type `traceRowToItem` expects.
  const callingTraceIds = db
    .selectDistinct({ traceId: spans.traceId })
    .from(spans)
    .where(
      and(
        eq(spans.toolName, toolName),
        eq(spans.workspaceId, workspaceId),
        gte(spans.ingestedAt, sql`now() - interval '90 days'`),
      ),
    );
  const rows = await db
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
  const totalRows = await db.select({ n: sql<number>`count(*)::int` }).from(traces).where(drillWhere);
  return { traces: rows.map(traceRowToItem), total: totalRows[0]?.n ?? 0, limit, offset: 0 };
}


