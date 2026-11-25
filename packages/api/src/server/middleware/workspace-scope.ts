/**
 * Binds the authenticated workspace to the request's async context, so every
 * database statement it triggers is confined to that workspace by PostgreSQL
 * itself rather than by the predicate each query happens to carry.
 *
 * Mounted AFTER the bearer middleware: the scope comes from the resolved
 * Principal, never from the body, the path or a header. That ordering is the
 * security property — a scope taken from caller input would let a client name
 * someone else's workspace and have RLS faithfully honour it.
 *
 * `/v1/admin/*` is deliberately NOT behind this: those routes are gated by
 * `requireScope` and cross workspaces by design.
 *
 * @see @looptrace/core/infra — workspace-scope.ts, tenant-scoped-pool.ts
 * @see packages/core/src/infrastructure/db/migrations/0033_rls_fail_closed.sql
 */
import { withWorkspaceScope } from "@looptrace/core/infra";
import type { MiddlewareHandler } from "hono";

import { getPrincipal } from "../auth/middleware.js";

/** Runs the remainder of the request inside the Principal's workspace scope. */
export function workspaceScope(): MiddlewareHandler {
  return async (c, next) => {
    const { workspaceId } = getPrincipal(c);
    await withWorkspaceScope(workspaceId, async () => {
      await next();
    });
  };
}
