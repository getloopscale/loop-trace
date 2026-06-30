import { sql } from "drizzle-orm";
import {
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * M22 multi-tenant workspace isolation. Every data row carries `workspace_id`
 * (== tenant_id; the data plane does not know about accounts — theo-data
 * invariant 2). Added `DEFAULT 'default' NOT NULL` so the migration is
 * non-destructive (PG-11 metadata-only) and a single-tenant deployment keeps
 * working via the seeded `default` workspace. Reused by every table below.
 */
const workspaceIdCol = () =>
  text("workspace_id").default("default").notNull();

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
    // M22: span_id is client-supplied (OTLP) → no longer a global PK. The composite
    // PK (workspace_id, span_id) keeps every upsert per-workspace so a cross-tenant
    // span_id collision creates a separate row instead of silently dropping the
    // second tenant's span (onConflictDoNothing) — an isolation/data-loss defect.
    spanId: text("span_id").notNull(),
    workspaceId: workspaceIdCol(),
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
    // M34: Claude Code perf/cost signals from `claude_code.llm_request`. Nullable →
    // absent for non-Claude spans + existing rows (backward-compatible).
    ttftMs: integer("ttft_ms"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheCreationTokens: integer("cache_creation_tokens"),
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
    primaryKey({ columns: [t.workspaceId, t.spanId] }),
    index("spans_workspace_id_idx").on(t.workspaceId),
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
    // M22: trace_id is no longer a global PK — a given trace_id may exist in two
    // workspaces as separate rows. The composite PK (workspace_id, trace_id) keeps
    // the recompute upsert per-workspace so a cross-tenant trace_id collision can
    // never flip ownership or cross-sum aggregates (review F-sec-3).
    traceId: text("trace_id").notNull(),
    workspaceId: workspaceIdCol(),
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
    primaryKey({ columns: [t.workspaceId, t.traceId] }),
    index("traces_workspace_id_idx").on(t.workspaceId),
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
    // M22: composite PK (workspace_id, session_id) — session_id is a low-entropy
    // client-supplied value, so a global PK let the first workspace to ingest a
    // given session_id "own" it and leak others' traces sharing it (review F-sec-1/2).
    sessionId: text("session_id").notNull(),
    workspaceId: workspaceIdCol(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  },
  // Backs the M13 sessions list ORDER BY last_seen_at DESC (same time-ordered-list
  // pattern as traces_updated_at_idx / replay_sessions_opened_at_idx).
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.sessionId] }),
    index("sessions_workspace_id_idx").on(t.workspaceId),
    index("sessions_last_seen_at_idx").on(t.lastSeenAt),
  ],
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
    workspaceId: workspaceIdCol(),
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
    workspaceId: workspaceIdCol(),
    traceId: text("trace_id").notNull(),
    tag: text("tag").notNull(),
  },
  (t) => [
    // M22: workspace-leading — the same (trace_id, tag) in two workspaces must not
    // collide (a cross-tenant trace_id is a distinct tag row per workspace).
    unique("trace_tags_trace_id_tag_uq").on(t.workspaceId, t.traceId, t.tag),
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
    workspaceId: workspaceIdCol(),
    spanId: text("span_id").notNull(),
    traceId: text("trace_id").notNull(),
    name: text("name").notNull(),
    score: doublePrecision("score"),
    label: text("label"),
    explanation: text("explanation"),
  },
  (t) => [
    // M22: workspace-leading — a (span_id, evaluator name) collision across tenants
    // must be two distinct rows, never an upsert that overwrites the other tenant.
    unique("span_evaluations_span_id_name_uq").on(
      t.workspaceId,
      t.spanId,
      t.name,
    ),
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
    workspaceId: workspaceIdCol(),
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
    // M22: workspace-leading — a (trace, span, name, channel) collision across
    // tenants must be two distinct annotations, never a cross-tenant upsert.
    unique("annotations_target_channel_uq").on(
      t.workspaceId,
      t.traceId,
      t.spanId,
      t.name,
      t.annotatorKind,
    ),
    index("annotations_trace_id_idx").on(t.traceId),
  ],
);

/**
 * M26d: curated datasets. A named set of example traces. `name` is UNIQUE so create
 * is idempotent "create-or-get" (D1). Distinct from the trace lifecycle — datasets +
 * their items are NEVER pruned (a curated example outlives its source trace, D2).
 */
export const datasets = pgTable(
  "datasets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: workspaceIdCol(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  // M22: the dedup unique is workspace-leading — the same dataset name in two
  // workspaces must not collide (theo-data EC-12).
  (t) => [unique("datasets_workspace_id_name_uq").on(t.workspaceId, t.name)],
);

/**
 * M26d: a dataset item — one curated example. Snapshots the source trace's root
 * input/output AT ADD-TIME (D2) so the example survives the trace being pruned.
 * UNIQUE(dataset_id, trace_id) makes add idempotent (ON CONFLICT DO NOTHING, D3).
 */
export const datasetItems = pgTable(
  "dataset_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: workspaceIdCol(),
    datasetId: uuid("dataset_id").notNull(),
    traceId: text("trace_id").notNull(),
    inputSnapshot: text("input_snapshot"),
    outputSnapshot: text("output_snapshot"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // M22: workspace-leading (dataset_id is a server UUID, already isolated; the
    // leading workspace_id keeps the dedup key consistent with every other table).
    unique("dataset_items_dataset_id_trace_id_uq").on(
      t.workspaceId,
      t.datasetId,
      t.traceId,
    ),
    index("dataset_items_dataset_id_idx").on(t.datasetId),
  ],
);

/**
 * M22 — the tenant boundary. Every `workspace_id` on a data row references a row
 * here (logically; FK enforced on `theo_api_keys` only to keep ingest hot-path
 * free). Seeded with a `default` workspace so single-tenant deployments work.
 * Ported from theo-memory migration 0016.
 */
export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * M22 — workspace membership: a user's `role` WITHIN a workspace (orthogonal to a
 * key's scopes). PK (workspace_id, user_id). Ported from theo-memory 0017.
 */
export const workspaceUsers = pgTable(
  "workspace_users",
  {
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").default("member").notNull(),
  },
  (t) => [
    unique("workspace_users_pk").on(t.workspaceId, t.userId),
    index("workspace_users_workspace_id_idx").on(t.workspaceId),
  ],
);

/**
 * M22 — per-tenant API keys (the data-plane half of the auth pattern). The key is
 * stored only as a SHA-256 hash (never the raw secret). `scopes` is jsonb holding
 * `lens:*` capabilities. `tenant_id` is the single-tenant-OSS isolation marker
 * (always `'self'` here). `workspace_id` binds the key to its tenant. Ported from
 * theo-memory migrations 0012/0016/0017.
 */
export const theoApiKeys = pgTable(
  "theo_api_keys",
  {
    id: varchar("id", { length: 20 }).primaryKey(),
    subject: text("subject").notNull(),
    tenantId: text("tenant_id").default("self").notNull(),
    workspaceId: text("workspace_id").default("default").notNull(),
    userId: text("user_id"),
    keyName: varchar("key_name", { length: 64 }).notNull(),
    keyHash: varchar("key_hash", { length: 64 }).notNull(),
    keyPrefix: varchar("key_prefix", { length: 12 }).notNull(),
    scopes: jsonb("scopes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    rotatedFrom: varchar("rotated_from", { length: 20 }),
  },
  (t) => [
    unique("theo_api_keys_key_hash_uq").on(t.keyHash),
    index("theo_api_keys_subject_tenant_idx").on(t.subject, t.tenantId),
    index("theo_api_keys_workspace_id_idx").on(t.workspaceId),
  ],
);
