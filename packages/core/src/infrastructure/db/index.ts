/**
 * @usetheo/lens-core/infra — the infrastructure (Drizzle) subpath entry.
 *
 * M122: the concrete persistence adapters + raw table schemas live behind this
 * explicit `/infra` door so the root barrel (`@usetheo/lens-core`) exposes only the
 * domain surface (ports, value objects, zod DTOs). Composition roots import their
 * concretes from here; nothing else should. See ADR D1–D3 of the M122 plan.
 */
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
export { spans, traces, sessions, replaySessions, evaluators, guards } from "./schema.js";
