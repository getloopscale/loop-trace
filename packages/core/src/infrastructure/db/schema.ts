import { sql } from "drizzle-orm";
import {
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/** Postgres `tsvector` (M24 full-text search) — no built-in drizzle type. */
const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

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
    toolName: text("tool_name"),
    sessionId: text("session_id"),
    // M12: span input/output text (capped at ingest) + OTLP events. Nullable →
    // existing rows read graceful (backward-compatible).
    inputValue: text("input_value"),
    outputValue: text("output_value"),
    events: jsonb("events"),
    attributes: jsonb("attributes"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    // M24: full-text search vector over input+output, maintained by Postgres
    // (GENERATED STORED) — no write-path change. NULL-safe via coalesce.
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(
      sql`to_tsvector('english', coalesce(input_value, '') || ' ' || coalesce(output_value, ''))`,
    ),
  },
  (t) => [
    index("spans_trace_id_idx").on(t.traceId),
    index("spans_parent_span_id_idx").on(t.parentSpanId),
    // Backs per-tool aggregation + drill-down (M6 risk #2).
    index("spans_tool_name_idx").on(t.toolName),
    // Backs the M9 model filter subquery (traces whose spans use a model).
    index("spans_model_idx").on(t.model),
    // Backs the M11 time-windowed span scans (tokens-by-model over a range).
    index("spans_ingested_at_idx").on(t.ingestedAt),
    // M24: backs the full-text `search_tsv @@ websearch_to_tsquery(...)` filter.
    index("spans_search_tsv_gin_idx").using("gin", t.searchTsv),
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
    // Backs the M9 status filter (ok/error).
    index("traces_status_code_idx").on(t.statusCode),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    sessionId: text("session_id").primaryKey(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  // Backs the M13 sessions list ORDER BY last_seen_at DESC (same time-ordered-list
  // pattern as traces_updated_at_idx / replay_sessions_opened_at_idx).
  (t) => [index("sessions_last_seen_at_idx").on(t.lastSeenAt)],
);

/**
 * M8 north-star: one row per replay opened in the UI. Replay is otherwise
 * client-only and ephemeral, so this is the sole data source for the
 * "replay sessions per week" metric. `opened_at` is indexed to back the weekly
 * date_trunc aggregation.
 */
export const replaySessions = pgTable(
  "replay_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    traceId: text("trace_id").notNull(),
    openedAt: timestamp("opened_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("replay_sessions_opened_at_idx").on(t.openedAt),
    // M23: backs the retention cascade `DELETE … WHERE trace_id IN (stale)` so a
    // sweep does not sequential-scan replay_sessions.
    index("replay_sessions_trace_id_idx").on(t.traceId),
  ],
);

/**
 * M14: free-form tags on a trace — a lightweight grouping orthogonal to sessions.
 * A side table keyed by trace_id (like replay_sessions); NO change to spans/traces.
 * UNIQUE(trace_id, tag) makes add idempotent (ON CONFLICT DO NOTHING); the tag
 * index backs the list `?tag=` filter; the trace_id index backs reading a trace's tags.
 */
export const traceTags = pgTable(
  "trace_tags",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    traceId: text("trace_id").notNull(),
    tag: text("tag").notNull(),
  },
  (t) => [
    unique("trace_tags_trace_id_tag_uq").on(t.traceId, t.tag),
    index("trace_tags_tag_idx").on(t.tag),
    index("trace_tags_trace_id_idx").on(t.traceId),
  ],
);

/**
 * M26: online evaluations attached to a span (read-path). Populated only at ingest
 * from `eval.<name>.*` span attributes (no human write-path — that is M26b). One row
 * per (span, evaluator); idempotent on re-ingest via the unique key. Mirrors the
 * `trace_tags` side-table so per-evaluator aggregates are trivial indexed SQL.
 */
export const spanEvaluations = pgTable(
  "span_evaluations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    spanId: text("span_id").notNull(),
    traceId: text("trace_id").notNull(),
    name: text("name").notNull(),
    score: doublePrecision("score"),
    label: text("label"),
    explanation: text("explanation"),
  },
  (t) => [
    unique("span_evaluations_span_id_name_uq").on(t.spanId, t.name),
    index("span_evaluations_name_idx").on(t.name),
    index("span_evaluations_trace_id_idx").on(t.traceId),
  ],
);

/**
 * M26b: human-feedback annotations (write-path). A human attaches a 👍/👎 `label`
 * and/or a free-text `note` to a trace (`span_id = ''` sentinel) or a span
 * (`span_id` set), on a `name` channel, authored by `annotator_kind`. UPSERT — one
 * row per (trace, span, name, annotator_kind); re-submitting replaces (latest wins,
 * D2). `span_id` is NOT NULL DEFAULT '' so the unique key is a plain column tuple
 * (a nullable span_id would defeat the unique via Postgres NULL != NULL). Distinct
 * from the immutable `span_evaluations` read-path (D3).
 */
export const annotations = pgTable(
  "annotations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    traceId: text("trace_id").notNull(),
    spanId: text("span_id").default("").notNull(),
    name: text("name").notNull(),
    label: text("label"),
    note: text("note"),
    annotatorKind: text("annotator_kind").default("HUMAN").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("annotations_target_channel_uq").on(
      t.traceId,
      t.spanId,
      t.name,
      t.annotatorKind,
    ),
    index("annotations_trace_id_idx").on(t.traceId),
  ],
);
