/**
 * M36 — evaluator + guard CRUD/run handlers (the admin-keys.ts handler-module
 * pattern keeps app.ts lean, D1). Every handler reads the workspace from the
 * Principal (never the body, M22 invariant 3); per-verb scope is enforced by the
 * route guards in app.ts. Predicate is validated at the boundary (EC-1).
 */
import type { Context } from "hono";

import { z } from "zod";
import {
  evaluatorSchema,
  guardSchema,
  validatePredicate,
  runEvaluator,
  NameConflictError,
  type Evaluator,
  type EvaluatorRepository,
  type EngineDeps,
  apiError,
  zodFieldErrors,
} from "@usetheo/lens-core";

import { getPrincipal } from "../auth/middleware.js";

/**
 * M82 — a partial evaluator edit. `name` follows the same rule as create; `kind`+`config`, when present,
 * must satisfy the create discriminated union (never a half-typed config). A bare `{name}` renames.
 */
const evaluatorUpdateSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9_-]{1,64}$/, "name must match ^[a-z0-9_-]{1,64}$").optional(),
    target: z.string().optional(),
    passLabel: z.string().optional(),
    failLabel: z.string().optional(),
    enabled: z.boolean().optional(),
    kind: z.enum(["rule", "llm_judge"]).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** Deps the evaluator routes need (wired by the composition root). */
export interface EvaluatorApiDeps {
  repo: EvaluatorRepository;
  engine: EngineDeps;
}

async function readJson(c: Context): Promise<unknown | null> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export async function createEvaluatorHandler(c: Context, deps: EvaluatorApiDeps): Promise<Response> {
  const body = await readJson(c);
  if (body === null) return c.json(apiError("INVALID_BODY", "invalid json body"), 400);
  const parsed = evaluatorSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(apiError("INVALID_EVALUATOR", "invalid evaluator", zodFieldErrors(parsed.error)), 400);
  }
  const ev = parsed.data;
  // EC-1: a non-empty rule predicate that parses to zero clauses would match every
  // span (silent pass-all). Reject at the boundary.
  if (ev.kind === "rule") {
    const reason = validatePredicate(ev.config.predicate);
    if (reason !== null) {
      return c.json(apiError("INVALID_PREDICATE", reason), 400);
    }
  }
  const rec = await deps.repo.createEvaluator(ev, getPrincipal(c).workspaceId);
  return c.json(rec, 200);
}

export async function listEvaluatorsHandler(c: Context, deps: EvaluatorApiDeps): Promise<Response> {
  const evaluators = await deps.repo.listEvaluators(getPrincipal(c).workspaceId);
  return c.json({ evaluators }, 200);
}

export async function getEvaluatorHandler(c: Context, deps: EvaluatorApiDeps): Promise<Response> {
  const rec = await deps.repo.getEvaluator(c.req.param("id") ?? "", getPrincipal(c).workspaceId);
  return rec ? c.json(rec, 200) : c.json(apiError("EVALUATOR_NOT_FOUND", "not found"), 404);
}

export async function updateEvaluatorHandler(c: Context, deps: EvaluatorApiDeps): Promise<Response> {
  const body = await readJson(c);
  if (body === null) return c.json(apiError("INVALID_BODY", "invalid json body"), 400);
  const parsed = evaluatorUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(apiError("INVALID_EVALUATOR", "invalid evaluator", zodFieldErrors(parsed.error)), 400);
  }
  const updates = parsed.data;
  // If the caller changes kind/config, validate the pair against the create union (never store a
  // half-typed config). A rename (`{name}`) skips this.
  if (updates.kind !== undefined || updates.config !== undefined) {
    if (updates.kind === undefined || updates.config === undefined) {
      return c.json(apiError("INVALID_EVALUATOR", "kind and config must be provided together"), 400);
    }
    const full = evaluatorSchema.safeParse({ name: updates.name ?? "placeholder_name", kind: updates.kind, config: updates.config });
    if (!full.success) {
      return c.json(apiError("INVALID_EVALUATOR", "invalid evaluator", zodFieldErrors(full.error)), 400);
    }
    if (updates.kind === "rule") {
      const reason = validatePredicate((updates.config as { predicate: string }).predicate);
      if (reason !== null) return c.json(apiError("INVALID_PREDICATE", reason), 400);
    }
  }
  try {
    const rec = await deps.repo.updateEvaluator(c.req.param("id") ?? "", updates as Partial<Evaluator>, getPrincipal(c).workspaceId);
    return rec ? c.json(rec, 200) : c.json(apiError("EVALUATOR_NOT_FOUND", "not found"), 404);
  } catch (err) {
    if (err instanceof NameConflictError) return c.json(apiError("NAME_CONFLICT", err.message), 409);
    throw err;
  }
}

export async function deleteEvaluatorHandler(c: Context, deps: EvaluatorApiDeps): Promise<Response> {
  await deps.repo.deleteEvaluator(c.req.param("id") ?? "", getPrincipal(c).workspaceId);
  return c.body(null, 204);
}

export async function runEvaluatorHandler(c: Context, deps: EvaluatorApiDeps): Promise<Response> {
  const ws = getPrincipal(c).workspaceId;
  const ev = await deps.repo.getEvaluator(c.req.param("id") ?? "", ws);
  if (ev === null) {
    return c.json(apiError("EVALUATOR_NOT_FOUND", "not found"), 404);
  }
  // Validate the run body at the boundary (EVAL-2): garbage traceIds / a negative or
  // non-integer limit are rejected rather than reaching the engine untrusted.
  const raw = (await readJson(c)) as Record<string, unknown> | null;
  const opts: { traceIds?: string[]; limit?: number } = {};
  if (raw && raw["traceIds"] !== undefined) {
    if (!Array.isArray(raw["traceIds"]) || raw["traceIds"].some((t) => typeof t !== "string")) {
      return c.json(apiError("INVALID_RUN_OPTS", "traceIds must be string[]"), 400);
    }
    opts.traceIds = raw["traceIds"] as string[];
  }
  if (raw && raw["limit"] !== undefined) {
    const lim = raw["limit"];
    if (typeof lim !== "number" || !Number.isInteger(lim) || lim <= 0) {
      return c.json(apiError("INVALID_RUN_OPTS", "limit must be a positive integer"), 400);
    }
    opts.limit = lim;
  }
  const result = await runEvaluator(ev, opts, ws, deps.engine);
  return c.json(result, 200);
}

export async function createGuardHandler(c: Context, deps: EvaluatorApiDeps): Promise<Response> {
  const body = await readJson(c);
  if (body === null) return c.json(apiError("INVALID_BODY", "invalid json body"), 400);
  const parsed = guardSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(apiError("INVALID_GUARD", "invalid guard", zodFieldErrors(parsed.error)), 400);
  }
  const ws = getPrincipal(c).workspaceId;
  // EVAL-5: reject a guard pointing at a non-existent (or cross-workspace) evaluator
  // loudly (404) instead of storing an inert guard.
  const target = await deps.repo.getEvaluator(parsed.data.evaluatorId, ws);
  if (target === null) {
    return c.json(apiError("EVALUATOR_NOT_FOUND", "guard.evaluatorId not found in workspace"), 404);
  }
  const rec = await deps.repo.createGuard(parsed.data, ws);
  return c.json(rec, 200);
}

export async function listGuardsHandler(c: Context, deps: EvaluatorApiDeps): Promise<Response> {
  const guards = await deps.repo.listGuards(getPrincipal(c).workspaceId);
  return c.json({ guards }, 200);
}

export async function deleteGuardHandler(c: Context, deps: EvaluatorApiDeps): Promise<Response> {
  await deps.repo.deleteGuard(c.req.param("id") ?? "", getPrincipal(c).workspaceId);
  return c.body(null, 204);
}

export async function guardBreachesHandler(c: Context, deps: EvaluatorApiDeps): Promise<Response> {
  const traceIds = await deps.repo.listBreachingTraces(
    c.req.param("id") ?? "",
    getPrincipal(c).workspaceId,
  );
  return c.json({ traceIds }, 200);
}
