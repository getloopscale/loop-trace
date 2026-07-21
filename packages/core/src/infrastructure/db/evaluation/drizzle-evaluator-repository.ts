/**
 * M36 — Drizzle adapter for {@link EvaluatorRepository} (D1: separate from the
 * 1553-LoC span repo). Every query is workspace-scoped (M22). Verdict writes upsert
 * the workspace-leading `(workspace_id, span_id, name)` unique so re-runs are
 * idempotent (D2/D6); deleting an evaluator cascades its monitors in one tx (EC-4).
 */
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import { DEFAULT_WORKSPACE_ID } from "../../../domain/principal.js";
import { parsePoolConfig } from "../../../domain/evaluation/evaluator-config.js";
import { NameConflictError, isUniqueViolation } from "../../../domain/errors.js";
import { isUuid } from "../uuid.js";
import type { Evaluator, Guard, Verdict } from "../../../domain/evaluation/evaluator.js";
import type {
  EvaluatorRepository,
  EvaluatorRecord,
  GuardRecord, GuardBreachWindow } from "../../../domain/evaluation/evaluator-repository.js";
import { evaluators, monitors, spanEvaluations } from "../schema.js";

type EvaluatorRow = typeof evaluators.$inferSelect;
type MonitorRow = typeof monitors.$inferSelect;

function toEvaluatorRecord(row: EvaluatorRow): EvaluatorRecord {
  const base = {
    id: row.id,
    name: row.name,
    target: row.target,
    enabled: row.enabled === 1,
    createdAt: row.createdAt.toISOString(),
    // M134 — auto-evaluation. Read back so the ingest hook can decide whether
    // this evaluator wants new traces, at what rate, and for which of them.
    autoEnabled: row.autoEnabled === 1,
    sampling: row.sampling,
    filter: (row.filter ?? []) as unknown[],
    ...(row.passLabel != null ? { passLabel: row.passLabel } : {}),
    ...(row.failLabel != null ? { failLabel: row.failLabel } : {}),
  };
  // `config` is the kind-specific jsonb; the discriminated union is reconstructed.
  return {
    ...base,
    kind: row.kind as "rule" | "llm_judge",
    config: row.config,
  } as EvaluatorRecord;
}

function toGuardRecord(row: MonitorRow): GuardRecord {
  return {
    id: row.id,
    evaluatorId: row.evaluatorId,
    operator: row.operator as GuardRecord["operator"],
    enabled: row.enabled === 1,
    createdAt: row.createdAt.toISOString(),
    ...(row.threshold != null ? { threshold: row.threshold } : {}),
    ...(row.labelValue != null ? { labelValue: row.labelValue } : {}),
  };
}

export class DrizzleEvaluatorRepository implements EvaluatorRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async createEvaluator(
    ev: Evaluator,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<EvaluatorRecord> {
    const values = {
      workspaceId,
      name: ev.name,
      kind: ev.kind,
      target: ev.target,
      config: ev.config,
      passLabel: ev.passLabel ?? null,
      failLabel: ev.failLabel ?? null,
      enabled: ev.enabled ? 1 : 0,
      // M134 — persisted with the same backward-compatible defaults as the
      // column defaults, so an older client that omits them keeps today's
      // behaviour (auto OFF, no judge spend on upgrade).
      autoEnabled: (ev as { autoEnabled?: boolean }).autoEnabled ? 1 : 0,
      sampling: (ev as { sampling?: number }).sampling ?? 1,
      filter: ((ev as { filter?: unknown }).filter ?? []) as unknown,
    };
    const rows = await this.db
      .insert(evaluators)
      .values(values)
      .onConflictDoUpdate({
        target: [evaluators.workspaceId, evaluators.name],
        set: {
          kind: values.kind,
          target: values.target,
          config: values.config,
          passLabel: values.passLabel,
          failLabel: values.failLabel,
          enabled: values.enabled,
        },
      })
      .returning();
    return toEvaluatorRecord(rows[0]!);
  }

  async listEvaluators(
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<EvaluatorRecord[]> {
    const rows = await this.db
      .select()
      .from(evaluators)
      .where(eq(evaluators.workspaceId, workspaceId));
    return rows.map(toEvaluatorRecord);
  }

  async getEvaluator(
    id: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<EvaluatorRecord | null> {
    if (!isUuid(id)) return null; // non-uuid path param → absent, not a 500 (22P02) — Rule 8
    const rows = await this.db
      .select()
      .from(evaluators)
      .where(and(eq(evaluators.id, id), eq(evaluators.workspaceId, workspaceId)))
      .limit(1);
    return rows[0] ? toEvaluatorRecord(rows[0]) : null;
  }

  async updateEvaluator(
    id: string,
    updates: Partial<Evaluator>,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<EvaluatorRecord | null> {
    // M82: a partial edit (rename / enable / config). Build the SET from provided fields only; a
    // (workspace_id, name) collision surfaces as a typed NameConflictError (route → 409, ADR-1).
    if (!isUuid(id)) return null; // non-uuid path param → absent (404), not a 500 (22P02) — Rule 8
    const set: Record<string, unknown> = {};
    if (updates.name !== undefined) set.name = updates.name;
    if (updates.target !== undefined) set.target = updates.target;
    if ("config" in updates && updates.config !== undefined) set.config = updates.config;
    if (updates.passLabel !== undefined) set.passLabel = updates.passLabel ?? null;
    if (updates.failLabel !== undefined) set.failLabel = updates.failLabel ?? null;
    if (updates.enabled !== undefined) set.enabled = updates.enabled ? 1 : 0;
    if ("kind" in updates && updates.kind !== undefined) set.kind = updates.kind;
    // M134 — without these three the auto-eval knobs were accepted and validated
    // by the handler, built an EMPTY set, hit the "nothing to change" return
    // below, and answered 200 with the OLD row. Enabling auto-evaluation on an
    // existing evaluator was therefore impossible through the API: delete and
    // recreate was the only path.
    const m134 = updates as {
      autoEnabled?: boolean;
      sampling?: number;
      filter?: unknown;
    };
    if (m134.autoEnabled !== undefined) set.autoEnabled = m134.autoEnabled ? 1 : 0;
    if (m134.sampling !== undefined) set.sampling = m134.sampling;
    if (m134.filter !== undefined) set.filter = m134.filter;
    if (Object.keys(set).length === 0) return this.getEvaluator(id, workspaceId); // nothing to change
    let rows: EvaluatorRow[];
    try {
      rows = await this.db
        .update(evaluators)
        .set(set)
        .where(and(eq(evaluators.id, id), eq(evaluators.workspaceId, workspaceId)))
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) throw new NameConflictError("an evaluator with that name already exists");
      throw err;
    }
    return rows[0] ? toEvaluatorRecord(rows[0]) : null;
  }

  async deleteEvaluator(
    id: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<void> {
    if (!isUuid(id)) return; // non-uuid path param → no-op (204 idempotent), not a 500 (22P02) — Rule 8
    // EC-4: cascade — drop the evaluator's monitors in the SAME transaction so no
    // orphan monitor survives (monitors have no DB FK, like every table here).
    await this.db.transaction(async (tx) => {
      await tx
        .delete(monitors)
        .where(
          and(eq(monitors.evaluatorId, id), eq(monitors.workspaceId, workspaceId)),
        );
      await tx
        .delete(evaluators)
        .where(
          and(eq(evaluators.id, id), eq(evaluators.workspaceId, workspaceId)),
        );
    });
  }

  async createGuard(
    guard: Guard,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<GuardRecord> {
    const rows = await this.db
      .insert(monitors)
      .values({
        workspaceId,
        evaluatorId: guard.evaluatorId,
        operator: guard.operator,
        threshold: guard.threshold ?? null,
        labelValue: guard.labelValue ?? null,
        enabled: guard.enabled ? 1 : 0,
      })
      .onConflictDoUpdate({
        target: [
          monitors.workspaceId,
          monitors.evaluatorId,
          monitors.operator,
          monitors.threshold,
          monitors.labelValue,
        ],
        set: { enabled: guard.enabled ? 1 : 0 },
      })
      .returning();
    return toGuardRecord(rows[0]!);
  }

  async listGuards(
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<GuardRecord[]> {
    const rows = await this.db
      .select()
      .from(monitors)
      .where(eq(monitors.workspaceId, workspaceId));
    return rows.map(toGuardRecord);
  }

  async deleteGuard(
    id: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<void> {
    if (!isUuid(id)) return; // non-uuid path param → no-op (204 idempotent), not a 500 (22P02) — Rule 8
    await this.db
      .delete(monitors)
      .where(and(eq(monitors.id, id), eq(monitors.workspaceId, workspaceId)));
  }

  async writeVerdict(
    workspaceId: string,
    span: { spanId: string; traceId: string },
    name: string,
    verdict: Verdict,
  ): Promise<void> {
    await this.db
      .insert(spanEvaluations)
      .values({
        workspaceId,
        spanId: span.spanId,
        traceId: span.traceId,
        name,
        score: verdict.score ?? null,
        label: verdict.label ?? null,
        explanation: verdict.explanation ?? null,
      })
      .onConflictDoUpdate({
        target: [
          spanEvaluations.workspaceId,
          spanEvaluations.spanId,
          spanEvaluations.name,
        ],
        set: {
          score: verdict.score ?? null,
          label: verdict.label ?? null,
          explanation: verdict.explanation ?? null,
        },
      });
  }

  /**
   * M135 — the windowed breach summary the scheduled evaluator reads.
   *
   * Windowed on the TRACE's `updated_at`, not the verdict's, because
   * `span_evaluations` carries no timestamp — and because the window is
   * semantically about traces anyway, matching both the observability series
   * and how retention prunes.
   *
   * The breach predicate MIRRORS `listBreachingTraces` above and the canonical `evaluateGuard`;
   * all three must stay in lock-step. That is enforced, not merely asked for — see
   * `breach-predicate-lockstep.test.ts`.
   *
   * KNOWN, DELIBERATE ASYMMETRY vs `listBreachingTraces`: this method joins `traces` and that one
   * does not, so a verdict whose trace has no `traces` row (an M26 `eval.<name>.*` verdict arriving
   * before recompute, or a trace pruned by retention while its verdicts remain) counts in the
   * drill-down list but not in the windowed count. This is not a bug to fix: the window predicate
   * IS `traces.updated_at`, so a verdict with no trace has no timestamp and cannot be placed in any
   * window. Counting it would mean asserting it happened at a time we do not know. Recorded here so
   * the next reader does not "align" the two relations and silently start counting untimed rows.
   */
  async guardBreachWindow(
    guardId: string,
    windowSeconds: number,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<GuardBreachWindow> {
    const absent = { breachCount: 0, evaluatedCount: 0, hasData: false, guardExists: false };
    // Mirrors listBreachingTraces: a non-uuid path param is absence, not a 500 (22P02).
    if (!isUuid(guardId)) return absent;

    const rows = await this.db.execute(sql`
      SELECT
        count(DISTINCT t.trace_id) FILTER (
          WHERE CASE g.operator
            WHEN 'lt'  THEN se.score IS NOT NULL AND se.score <  g.threshold
            WHEN 'lte' THEN se.score IS NOT NULL AND se.score <= g.threshold
            WHEN 'gt'  THEN se.score IS NOT NULL AND se.score >  g.threshold
            WHEN 'gte' THEN se.score IS NOT NULL AND se.score >= g.threshold
            WHEN 'eq'  THEN se.score IS NOT NULL AND se.score =  g.threshold
            WHEN 'label_eq' THEN se.label IS NOT NULL AND se.label = g.label_value
            ELSE false
          END
        )::int AS breach_count,
        count(DISTINCT t.trace_id)::int AS evaluated_count,
        -- Existence needs its own aggregate. An aggregate query with no GROUP BY returns exactly
        -- one row even when the FROM matches nothing, so row-presence proves nothing — that is
        -- precisely how the first draft of this method reported a deleted guard as a healthy one.
        count(g.id)::int AS guard_rows
      FROM monitors g
      -- LEFT joins, deliberately: an INNER join makes a guard with no verdicts indistinguishable
      -- from a guard that does not exist, which is the whole distinction this method carries.
      LEFT JOIN evaluators e ON e.id = g.evaluator_id AND e.workspace_id = g.workspace_id
      LEFT JOIN span_evaluations se ON se.name = e.name AND se.workspace_id = g.workspace_id
      LEFT JOIN traces t ON t.trace_id = se.trace_id AND t.workspace_id = se.workspace_id
        AND t.updated_at >= now() - (${String(Math.max(0, Math.floor(windowSeconds)))} || ' seconds')::interval
      WHERE g.id = ${guardId} AND g.workspace_id = ${workspaceId}
    `);

    const row = (rows.rows as { breach_count: number; evaluated_count: number; guard_rows: number }[])[0];
    if (row === undefined || Number(row.guard_rows) === 0) return absent;
    const evaluatedCount = Number(row.evaluated_count);
    return {
      guardExists: true,
      breachCount: Number(row.breach_count),
      evaluatedCount,
      // Absence is "nothing was evaluated", NOT "nothing breached".
      hasData: evaluatedCount > 0,
    };
  }

  async listBreachingTraces(
    guardId: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Promise<string[]> {
    if (!isUuid(guardId)) return []; // non-uuid path param → no breaches (empty), not a 500 (22P02) — Rule 8
    // Join guard → its evaluator → that evaluator's verdicts; a row breaches per the
    // guard's operator. Workspace-scoped on every table (M22). The breach predicate
    // is built from the controlled `operator` enum (no injection — bound params).
    // This CASE MIRRORS the canonical `evaluateGuard` (domain/evaluator.ts) — keep
    // them in lock-step (the operator-matrix integration test guards this side).
    // NOTE (EVAL-3): verdicts are matched by `name` within the workspace, so a guard
    // flags ALL same-named verdicts — both engine-computed AND any M26-ingested
    // `eval.<name>.*` rows of that name. This is intentional (a guard over "toxicity"
    // watches every toxicity verdict in the workspace), and is workspace-confined.
    const rows = await this.db.execute(sql`
      SELECT DISTINCT se.trace_id AS trace_id
      FROM monitors g
      JOIN evaluators e ON e.id = g.evaluator_id AND e.workspace_id = g.workspace_id
      JOIN span_evaluations se ON se.name = e.name AND se.workspace_id = g.workspace_id
      WHERE g.id = ${guardId} AND g.workspace_id = ${workspaceId}
        AND (
          CASE g.operator
            WHEN 'lt'  THEN se.score IS NOT NULL AND se.score <  g.threshold
            WHEN 'lte' THEN se.score IS NOT NULL AND se.score <= g.threshold
            WHEN 'gt'  THEN se.score IS NOT NULL AND se.score >  g.threshold
            WHEN 'gte' THEN se.score IS NOT NULL AND se.score >= g.threshold
            WHEN 'eq'  THEN se.score IS NOT NULL AND se.score =  g.threshold
            WHEN 'label_eq' THEN se.label IS NOT NULL AND se.label = g.label_value
            ELSE false
          END
        )
    `);
    return (rows.rows as { trace_id: string }[]).map((r) => r.trace_id);
  }
}

/** Factory mirroring `createSpanRepository` — pins a pool + drizzle instance. */
export function createEvaluatorRepository(connectionString: string): {
  repo: DrizzleEvaluatorRepository;
  pool: pg.Pool;
} {
  // M94: same pool resilience config as the span pool (max + timeouts) + the non-fatal idle-error
  // handler (an unhandled pool `error` crashes the process on a DB outage).
  const pool = new pg.Pool({ connectionString, ...parsePoolConfig() });
  pool.on("error", (err) => {
    console.error(JSON.stringify({ level: "error", msg: "pg pool idle-client error (non-fatal)", error: err.message }));
  });
  return { repo: new DrizzleEvaluatorRepository(drizzle(pool)), pool };
}

/**
 * Build an evaluator repo on an EXISTING pool (shares the span repo's pool, so the
 * api package never needs a direct `drizzle-orm` import — it stays in core).
 */
export function evaluatorRepoFromPool(pool: pg.Pool): DrizzleEvaluatorRepository {
  return new DrizzleEvaluatorRepository(drizzle(pool));
}
