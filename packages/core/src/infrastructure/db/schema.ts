import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
  uniqueIndex,
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
    // M95: composite (workspace_id, ingested_at) — serves the tenant filter AND the time range in ONE
    // scan (the single-column indexes served only one). Backs aggregateObservability tokens-by-model,
    // aggregateToolStats, and the facet-discovery recent-window scan.
    index("spans_workspace_ingested_idx").on(t.workspaceId, t.ingestedAt),
    // M24: backs the full-text `search_tsv @@ websearch_to_tsquery(...)` filter.
    index("spans_search_tsv_gin_idx").using("gin", t.searchTsv),
    // M95 NOTE: a jsonb GIN on `attributes` was evaluated and DROPPED — it accelerates `@>`
    // containment, NOT the M92 `attributes ->> key = value` predicate (empirically `EXPLAIN`-proven:
    // the `->>=` filter Seq-Scans regardless of the GIN). The `spans_workspace_ingested_idx` composite
    // narrows the scan window for the attr/facet filters instead; a true attr-value index would require
    // rewriting M92 to `@>` (a numeric-vs-string semantic change) — deferred to its own milestone.
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
    // M95: composite (workspace_id, updated_at) — one-scan tenant filter + time range/sort for
    // aggregateObservability (traffic/latency), aggregateCostByPeriod, aggregateNorthStar, listTraces.
    index("traces_workspace_updated_idx").on(t.workspaceId, t.updatedAt),
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
    // M95: composite (workspace_id, last_seen_at) — one-scan tenant filter + newest-first ORDER BY
    // for listSessions (server-paginated).
    index("sessions_workspace_last_seen_idx").on(t.workspaceId, t.lastSeenAt),
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
    // M95: composite (workspace_id, trace_id) — makes the listTraces per-row eval-count correlated
    // subquery (`WHERE se.workspace_id = $ AND se.trace_id = $`) INDEX-ONLY (was heap-hitting; B-H3).
    index("span_evaluations_workspace_trace_idx").on(t.workspaceId, t.traceId),
  ],
);

/**
 * M131 B1 — session-level Session Coherence verdicts (the session twin of span_evaluations).
 * Keyed (workspace, session_id, name); `session_version` (content hash of ordered trace-ids +
 * max ingested_at) makes a re-run a CACHE HIT when the session is unchanged (M131 B3). UPSERT —
 * one verdict per (session, name); re-judging a changed session overwrites. workspace-leading so a
 * (session_id, name) collision across tenants stays two rows.
 */
export const sessionEvaluations = pgTable(
  "session_evaluations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: workspaceIdCol(),
    sessionId: text("session_id").notNull(),
    name: text("name").notNull(),
    verdict: text("verdict").notNull(),
    score: doublePrecision("score"),
    reasoning: text("reasoning"),
    model: text("model"),
    sessionVersion: text("session_version").notNull(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("session_evaluations_session_id_name_uq").on(t.workspaceId, t.sessionId, t.name),
    index("session_evaluations_name_idx").on(t.name),
    index("session_evaluations_workspace_session_idx").on(t.workspaceId, t.sessionId),
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
 * M83: copilot answer feedback. A per-tenant thumbs up/down on one Ask-copilot answer. The ask is
 * stateless/single-turn (M33 D1/D4), so feedback is keyed by the CLIENT-side `turn_id` (the answer's
 * ordinal id in the thread) under its trace — a re-vote UPSERTs the label (up↔down toggle), never a
 * duplicate row. Workspace-leading unique so a `(trace, turn)` collision across tenants is two
 * distinct rows, never a cross-tenant upsert (M22).
 */
export const copilotFeedback = pgTable(
  "copilot_feedback",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: workspaceIdCol(),
    traceId: text("trace_id").notNull(),
    turnId: text("turn_id").notNull(),
    spanId: text("span_id").default("").notNull(),
    label: text("label").notNull(), // 'up' | 'down' (validated at the boundary)
    question: text("question"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("copilot_feedback_turn_uq").on(t.workspaceId, t.traceId, t.turnId),
    index("copilot_feedback_trace_id_idx").on(t.traceId),
    // Defense-in-depth: the label is a 2-value enum enforced at the DB, not only at the app boundary
    // — a future/other caller of recordAskFeedback cannot persist an out-of-domain label.
    check("copilot_feedback_label_ck", sql`${t.label} in ('up','down')`),
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
    datasetId: uuid("dataset_id")
      .notNull()
      // M101 (B-L3 / ADR 0003) — a real FK so a concurrent deleteDataset can NEVER leave an orphan
      // item: the insert's referential-integrity lock blocks the delete until it commits, then the
      // cascade removes the item (or the insert fails 23503 → the caller returns false).
      .references(() => datasets.id, { onDelete: "cascade" }),
    // The source ref: a real trace_id for a trace-sourced item, OR a synthetic `replay-{uuid}` id for a
    // playground-replay item (M55) whose input/output live in the snapshot columns. Always present, so
    // the item stays addressable (view + remove by this id) and the unique index dedups correctly.
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
 * M63: labeling-queue items. A span is enqueued for human review (`status = 'pending'`), a reviewer
 * resolves it with a label/score/note (`status = 'resolved'`), and resolved items export to a golden
 * dataset. `workspace_id`-scoped like every data row (theo-data invariant 2). The UNIQUE is a
 * workspace-leading **partial** index `(workspace_id, trace_id, span_id) WHERE status = 'pending'`
 * (D1) so at most ONE pending item exists per span per workspace (enqueue is idempotent while
 * pending), yet a span **can** be re-enqueued after it is resolved (the resolved row leaves the
 * partial index) and a span in two tenants never collides. `score` is double precision (clamped to
 * [0,1] in the domain); `resolution_version` records the payload schema (D3).
 */
export const labelingQueueItems = pgTable(
  "labeling_queue_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: workspaceIdCol(),
    traceId: text("trace_id").notNull(),
    spanId: text("span_id").notNull(),
    status: text("status").default("pending").notNull(),
    label: text("label"),
    score: doublePrecision("score"),
    note: text("note"),
    resolutionVersion: integer("resolution_version"),
    createdBy: text("created_by").notNull(),
    resolvedBy: text("resolved_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    // D1: workspace-leading PARTIAL unique — one PENDING item per span per workspace. Enqueue is
    // idempotent while pending; a resolved span leaves the index so it can be re-enqueued for a fresh
    // review; a span in two tenants never collides (theo-data invariant 2).
    uniqueIndex("labeling_queue_items_workspace_trace_span_pending_uq")
      .on(t.workspaceId, t.traceId, t.spanId)
      .where(sql`${t.status} = 'pending'`),
    index("labeling_queue_items_workspace_status_idx").on(t.workspaceId, t.status),
  ],
);

/**
 * M64: experiment runs. One execution of a dataset × a variant (model/prompt override) through the M33
 * provider path — the run carries the variant config + the computed aggregates (item/pass counts, avg
 * score, total cost). `workspace_id`-scoped like every data row (theo-data invariant 2). The `id` PK is
 * globally unique; the workspace-leading index keeps per-tenant list queries fast.
 */
export const experimentRuns = pgTable(
  "experiment_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: workspaceIdCol(),
    datasetId: uuid("dataset_id").notNull(),
    name: text("name").notNull(),
    variant: jsonb("variant").notNull(),
    status: text("status").default("completed").notNull(),
    truncated: boolean("truncated").default(false).notNull(),
    itemCount: integer("item_count").default(0).notNull(),
    passCount: integer("pass_count").default(0).notNull(),
    avgScore: doublePrecision("avg_score"),
    totalCostUsd: doublePrecision("total_cost_usd").default(0).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("experiment_runs_workspace_dataset_idx").on(t.workspaceId, t.datasetId),
    index("experiment_runs_workspace_created_idx").on(t.workspaceId, t.createdAt),
  ],
);

/**
 * M64: experiment run items — one row per dataset item per run: the replayed output + usage/cost + the
 * evaluator `scores` jsonb (reusing the M36 Verdict shape). `workspace_id`-leading UNIQUE `(workspace_id,
 * run_id, dataset_item_trace_id)` dedups a row per (run, source trace) and never collides across tenants.
 */
export const experimentRunItems = pgTable(
  "experiment_run_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: workspaceIdCol(),
    runId: uuid("run_id").notNull(),
    datasetItemTraceId: text("dataset_item_trace_id").notNull(),
    inputSnapshot: text("input_snapshot"),
    output: text("output"),
    promptTokens: integer("prompt_tokens").default(0).notNull(),
    completionTokens: integer("completion_tokens").default(0).notNull(),
    totalTokens: integer("total_tokens").default(0).notNull(),
    costUsd: doublePrecision("cost_usd"),
    latencyMs: integer("latency_ms").default(0).notNull(),
    model: text("model").default("").notNull(),
    scores: jsonb("scores").notNull(),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("experiment_run_items_workspace_run_trace_uq").on(t.workspaceId, t.runId, t.datasetItemTraceId),
    index("experiment_run_items_run_idx").on(t.runId),
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
 * `observability:*` capabilities. `tenant_id` is the single-tenant-OSS isolation marker
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

/**
 * M36: an online evaluator definition. `kind` selects the seam: `'rule'` (a
 * deterministic predicate reusing the M30 span-query DSL) or `'llm_judge'` (a
 * configurable OpenAI-compatible judge). `target` is a span-query selecting which
 * spans to evaluate (empty = the trace's root span). `config` jsonb holds the
 * kind-specific shape (`{predicate}` | `{prompt, model}`). Verdicts the engine
 * computes are written into `span_evaluations` (one row per matched span). Name is
 * the dedup key (create-or-update), workspace-leading (M22).
 */
export const evaluators = pgTable(
  "evaluators",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: workspaceIdCol(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    target: text("target").default("").notNull(),
    config: jsonb("config").notNull(),
    passLabel: text("pass_label"),
    failLabel: text("fail_label"),
    enabled: integer("enabled").default(1).notNull(),
    // M134: automatic evaluation of new traces.
    // `autoEnabled` defaults to 0 so upgrading starts NO judge spend — auto is
    // opted into per evaluator (plan Drawbacks #2).
    autoEnabled: integer("auto_enabled").default(0).notNull(),
    // Probability in [0,1] that a qualifying trace is actually scored. The only
    // lever that decouples judge cost from traffic volume (blueprint Q3).
    sampling: doublePrecision("sampling").default(1).notNull(),
    // WHICH TRACES trigger this evaluator. Distinct from `target` above, which
    // selects WHICH SPANS INSIDE a trace get scored. Conflating the two is the
    // single likeliest implementation error (plan glossary).
    filter: jsonb("filter").default([]).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  // M22: workspace-leading dedup — the same evaluator name in two workspaces is two
  // distinct rows; create-or-update upserts on this key.
  (t) => [
    unique("evaluators_workspace_id_name_uq").on(t.workspaceId, t.name),
    index("evaluators_workspace_id_idx").on(t.workspaceId),
  ],
);

/**
 * M36: a flag-only guard — a threshold over an evaluator's verdict. `operator` is
 * one of lt/lte/gt/gte/eq (over `threshold`) or label_eq (over `label_value`). A
 * breaching verdict flags the trace and, since M135, can notify. It NEVER blocks:
 * `guardrail` is a span KIND describing the inline blocker in the user's own app, which
 * theo-lens observes — it is not a theo-lens capability.
 * Workspace-leading (M22); deleting an evaluator cascades its monitors (EC-4).
 */
export const monitors = pgTable(
  "monitors",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: workspaceIdCol(),
    evaluatorId: uuid("evaluator_id").notNull(),
    operator: text("operator").notNull(),
    threshold: doublePrecision("threshold"),
    labelValue: text("label_value"),
    enabled: integer("enabled").default(1).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // M36 (review M36-EVAL-1): NULLS NOT DISTINCT — a numeric monitor has label_value
    // NULL (and a label_eq monitor has threshold NULL); under the PG default
    // (NULLS DISTINCT) two identical monitors never collide → the create upsert never
    // dedupes → duplicate rows. NULLS NOT DISTINCT makes the dedup actually fire.
    unique("monitors_workspace_id_dedup_uq")
      .on(t.workspaceId, t.evaluatorId, t.operator, t.threshold, t.labelValue)
      .nullsNotDistinct(),
    index("monitors_workspace_id_idx").on(t.workspaceId),
    index("monitors_evaluator_id_idx").on(t.evaluatorId),
  ],
);

/**
 * M134: the auto-evaluation work queue. Per ADR D1 this table IS the queue —
 * a worker claims a row with a conditional `UPDATE … RETURNING`, heartbeats
 * while running, and an orphan scan reclaims stale claims. Chosen over
 * BullMQ/Redis and Redis Streams because it is the only substrate where
 * accepted work cannot be lost and which needs no new infrastructure
 * (blueprint § Coverage Corner 3).
 *
 * Invariants this shape encodes:
 *  - dedup is a DB invariant, not application logic (ADR D4 / blueprint AP-1 —
 *    the reference deduped with a read-then-write and no unique index);
 *  - `attempts` + a terminal `failed` bound the retry loop, so a deterministic
 *    failure cannot be re-offered forever (EC-8);
 *  - `runAfter` gates claiming, so a trace still arriving across OTLP batches
 *    is re-armed rather than scored once on partial spans (EC-6);
 *  - `workspaceId` is carried on the row because the claim loop spans
 *    workspaces — the daemon must never assume a default tenant (EC-5).
 *
 * NOTE: this schema has no DB foreign keys by design, so `eval_jobs` MUST be
 * added to the retention cascade explicitly or it grows forever and its rows
 * outlive the traces they reference (EC-4).
 */
export const evalJobs = pgTable(
  "eval_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: workspaceIdCol(),
    evaluatorId: uuid("evaluator_id").notNull(),
    traceId: text("trace_id").notNull(),
    status: text("status").default("queued").notNull(),
    attempts: integer("attempts").default(0).notNull(),
    lastError: text("last_error"),
    runAfter: timestamp("run_after", { withTimezone: true })
      .defaultNow()
      .notNull(),
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // ADR D4 — one job per (workspace, evaluator, trace). Enqueue is an
    // idempotent upsert against this constraint.
    unique("eval_jobs_workspace_evaluator_trace_uq").on(
      t.workspaceId,
      t.evaluatorId,
      t.traceId,
    ),
    // Partial, on run_after alone, covering ONLY runnable rows. Measured on
    // 200k rows: the previous composite (status, run_after, claimed_at) was
    // never chosen — the claim's negated status predicate gives btree no scan
    // bound — so the planner seq-scanned and sorted (2707 buffers, 23.8 ms).
    // This one turns the same query into an index-ordered top-N (22 buffers,
    // 0.083 ms) and, because terminal rows fall OUT of the index, keeps claim
    // cost proportional to PENDING work rather than to lifetime volume.
    index("eval_jobs_runnable_idx")
      .on(t.runAfter)
      .where(sql`${t.status} IN ('queued', 'running')`),
    index("eval_jobs_workspace_id_idx").on(t.workspaceId),
  ],
);
