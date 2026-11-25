-- M136 Phase 1 — rename the capability to match what it actually does.
--
-- "Guard" promises request-path enforcement looptrace does not do. Both reference implementations
-- reserve GUARDRAIL for a span KIND that labels the inline blocker running in the user's own app;
-- a threshold over async verdicts is what the field calls a Monitor.
--
-- RENAME, not DROP + CREATE. A recreate would satisfy "does the monitors table exist" while
-- silently discarding every configured monitor, and would drop the NULLS NOT DISTINCT unique
-- constraint that makes the create-upsert actually dedupe (M36-EVAL-1). ALTER ... RENAME carries
-- rows, indexes, constraints and dependent foreign keys across untouched.
--
-- Indexes and constraints are renamed too. Postgres does not rename them automatically, and leaving
-- `guards_workspace_id_idx` on a table called `monitors` is precisely the mixed vocabulary this
-- milestone exists to remove — half a rename is worse than none, because the next reader cannot
-- tell whether the two names mean two things.
ALTER TABLE guards RENAME TO monitors;

ALTER INDEX guards_workspace_id_dedup_uq RENAME TO monitors_workspace_id_dedup_uq;
ALTER INDEX guards_workspace_id_idx RENAME TO monitors_workspace_id_idx;
ALTER INDEX guards_evaluator_id_idx RENAME TO monitors_evaluator_id_idx;
