import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import type { Span } from "../../domain/span.js";
import type { SpanRepository } from "../../domain/span-repository.js";
import { spans } from "./schema.js";

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
    startTimeUnixNano: span.startTimeUnixNano,
    endTimeUnixNano: span.endTimeUnixNano,
    statusCode: span.statusCode ?? null,
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
    ...(row.statusCode != null ? { statusCode: row.statusCode } : {}),
    ...(row.attributes != null
      ? { attributes: row.attributes as Record<string, unknown> }
      : {}),
  };
}

/**
 * Postgres adapter for {@link SpanRepository} (DIP). Constructed with an injected
 * Drizzle db so it stays testable and the composition root owns the concrete pool.
 */
export class DrizzleSpanRepository implements SpanRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async save(spansToSave: Span[]): Promise<void> {
    if (spansToSave.length === 0) return;
    // EC-1: dedupe intra-batch duplicate spanId — Postgres ON CONFLICT DO NOTHING
    // raises when rows conflict with each other within one INSERT statement.
    const unique = [...new Map(spansToSave.map((s) => [s.spanId, s])).values()];
    await this.db
      .insert(spans)
      .values(unique.map(toRow))
      .onConflictDoNothing({ target: spans.spanId });
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
}

export { drizzle };
