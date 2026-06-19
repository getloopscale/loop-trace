import { pgTable, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * M0 `spans` table — flat span storage proving the architecture. Fields mirror
 * the OTLP/JSON span shape; trace-tree assembly (via parent_span_id) is M1.
 *  - span_id: PK (unique per OTel spec)
 *  - trace_id: indexed (future tree queries)
 *  - parent_span_id: nullable (root spans have none)
 *  - start/end times: text (unix nanos exceed 2^53; precision-safe for M0)
 *  - attributes: jsonb (flattened OTLP attributes)
 */
export const spans = pgTable(
  "spans",
  {
    spanId: text("span_id").primaryKey(),
    traceId: text("trace_id").notNull(),
    parentSpanId: text("parent_span_id"),
    name: text("name").notNull(),
    startTimeUnixNano: text("start_time_unix_nano").notNull(),
    endTimeUnixNano: text("end_time_unix_nano").notNull(),
    statusCode: text("status_code"),
    attributes: jsonb("attributes"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("spans_trace_id_idx").on(t.traceId)],
);
