import { fileURLToPath } from "node:url";
import { desc, eq, sql } from "drizzle-orm";
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
import { spans, traces } from "./schema.js";

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
  constructor(private readonly db: NodePgDatabase) {}

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
    const rows = await this.db
      .select()
      .from(spans)
      .where(eq(spans.traceId, traceId));
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
