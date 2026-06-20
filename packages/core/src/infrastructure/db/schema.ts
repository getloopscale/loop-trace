import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * M1 trace data model. `spans` is the source of truth; `traces` and `sessions`
 * are ingest-time aggregates recomputed from spans (idempotent + race-safe — ADR D3).
 *  - ids are canonical lowercase hex (normalizeId, resolves M0 F-otlp-6)
 *  - start/end times are text (unix nanos exceed 2^53)
 *  - GenAI attributes (model/provider/tokens) extracted to typed columns; the full
 *    flattened attribute bag stays in `attributes` jsonb (events/links live there — D4)
 */
export const spans = pgTable(
  "spans",
  {
    spanId: text("span_id").primaryKey(),
    traceId: text("trace_id").notNull(),
    parentSpanId: text("parent_span_id"),
    name: text("name").notNull(),
    kind: text("kind"),
    startTimeUnixNano: text("start_time_unix_nano").notNull(),
    endTimeUnixNano: text("end_time_unix_nano").notNull(),
    statusCode: text("status_code"),
    statusMessage: text("status_message"),
    model: text("model"),
    provider: text("provider"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    sessionId: text("session_id"),
    attributes: jsonb("attributes"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("spans_trace_id_idx").on(t.traceId),
    index("spans_parent_span_id_idx").on(t.parentSpanId),
  ],
);

export const traces = pgTable(
  "traces",
  {
    traceId: text("trace_id").primaryKey(),
    sessionId: text("session_id"),
    name: text("name"),
    startTimeUnixNano: text("start_time_unix_nano"),
    endTimeUnixNano: text("end_time_unix_nano"),
    statusCode: text("status_code"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    costUsd: doublePrecision("cost_usd"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("traces_session_id_idx").on(t.sessionId),
    // Backs the day/week cost aggregation (M5 risk #2 — period GROUP BY date_trunc(updated_at)).
    index("traces_updated_at_idx").on(t.updatedAt),
  ],
);

export const sessions = pgTable("sessions", {
  sessionId: text("session_id").primaryKey(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
});
