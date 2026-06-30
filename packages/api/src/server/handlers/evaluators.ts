/**
 * M36 — evaluator + guard CRUD/run handlers (the admin-keys.ts handler-module
 * pattern keeps app.ts lean, D1). Every handler reads the workspace from the
 * Principal (never the body, M22 invariant 3); per-verb scope is enforced by the
 * route guards in app.ts. Predicate is validated at the boundary (EC-1).
 */
import type { Context } from "hono";

import {
  evaluatorSchema,
  guardSchema,
  validatePredicate,
  runEvaluator,
  type EvaluatorRepository,
  type EngineDeps,
} from "@usetheo/lens-core";

import { getPrincipal } from "../auth/middleware.js";

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
  if (body === null) return c.json({ code: "INVALID_BODY", message: "invalid json body" }, 400);
  const parsed = evaluatorSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ code: "INVALID_EVALUATOR", message: parsed.error.message }, 400);
  }
  const ev = parsed.data;
  // EC-1: a non-empty rule predicate that parses to zero clauses would match every
  // span (silent pass-all). Reject at the boundary.
  if (ev.kind === "rule") {
    const reason = validatePredicate(ev.config.predicate);
    if (reason !== null) {
      return c.json({ code: "INVALID_PREDICATE", message: reason }, 400);
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
  return rec ? c.json(rec, 200) : c.json({ code: "EVALUATOR_NOT_FOUND", message: "not found" }, 404);
}

export async function deleteEvaluatorHandler(c: Context, deps: EvaluatorApiDeps): Promise<Response> {
  await deps.repo.deleteEvaluator(c.req.param("id") ?? "", getPrincipal(c).workspaceId);
  return c.body(null, 204);
}

export async function runEvaluatorHandler(c: Context, deps: EvaluatorApiDeps): Promise<Response> {
  const ws = getPrincipal(c).workspaceId;
  const ev = await deps.repo.getEvaluator(c.req.param("id") ?? "", ws);
  if (ev === null) {
    return c.json({ code: "EVALUATOR_NOT_FOUND", message: "not found" }, 404);
  }
  const body = (await readJson(c)) as { traceIds?: string[]; limit?: number } | null;
  const opts = body ?? {};
  const result = await runEvaluator(ev, opts, ws, deps.engine);
  return c.json(result, 200);
}

export async function createGuardHandler(c: Context, deps: EvaluatorApiDeps): Promise<Response> {
  const body = await readJson(c);
  if (body === null) return c.json({ code: "INVALID_BODY", message: "invalid json body" }, 400);
  const parsed = guardSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ code: "INVALID_GUARD", message: parsed.error.message }, 400);
  }
  const rec = await deps.repo.createGuard(parsed.data, getPrincipal(c).workspaceId);
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
