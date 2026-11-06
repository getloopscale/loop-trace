import type pg from "pg";
import { fileURLToPath } from "node:url";
/**
 * @usetheo/lens-core/infra — the infrastructure (Drizzle) subpath entry.
 *
 * M122: the concrete persistence adapters + raw table schemas live behind this
 * explicit `/infra` door so the root barrel (`@usetheo/lens-core`) exposes only the
 * domain surface (ports, value objects, zod DTOs). Composition roots import their
 * concretes from here; nothing else should. See ADR D1–D3 of the M122 plan.
 */
export { spanRepoFromPool } from "./observability/drizzle-span-repository.js";
export {
  DrizzleSpanRepository,
  createPool,
  createSpanRepository,
  migrateLatest,
} from "./observability/drizzle-span-repository.js";
export {
  DrizzleEvaluatorRepository,
  createEvaluatorRepository,
  evaluatorRepoFromPool,
} from "./evaluation/drizzle-evaluator-repository.js";
export { spans, traces, sessions, replaySessions, evaluators, monitors } from "./schema.js";

/**
 * Apply every pending migration to `pool`.
 *
 * Exposed because `packages/core` OWNS the migrations directory, so it is the
 * only package that should reach for drizzle's migrator. Without this, an
 * integration test in another package must either declare drizzle itself — a
 * dependency it has no runtime need for — or silently depend on a sibling test
 * file having migrated the shared database first, which makes the suite
 * order-dependent (`rules/testing.md` § 3).
 *
 * Idempotent: drizzle records applied migrations, so calling it per test file
 * against one shared database is safe.
 */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));
  await migrate(drizzle(pool), { migrationsFolder });
}

// Tenant isolation (migration 0033): the request-bound workspace scope and the
// pool wrapper that pushes it down to PostgreSQL for the RLS policies.
export {
  withWorkspaceScope,
  withCrossWorkspaceScope,
  currentScope,
  isCrossWorkspace,
  WorkspaceScopeError,
  type WorkspaceScope,
  type CrossWorkspaceScope,
} from "./workspace-scope.js";
export { tenantScopedPool, describeScope } from "./tenant-scoped-pool.js";
