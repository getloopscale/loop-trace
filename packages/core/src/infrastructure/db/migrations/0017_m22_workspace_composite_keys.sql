-- M22 (review F-sec-1/2/3 + isolation completeness): make every client-supplied
-- identifier WORKSPACE-LEADING so a cross-tenant id collision can never alias rows.
--
-- A global single-column key (traces.trace_id, sessions.session_id, spans.span_id)
-- let a low-entropy/shared id collide across workspaces — leaking aggregates +
-- content on read, flipping ownership on the recompute upsert, and silently dropping
-- the second tenant's row on insert (onConflictDoNothing). Composite keys keep every
-- upsert per-workspace; the unique constraints become workspace-leading so a tag /
-- eval / annotation / dataset-item with a colliding id is a distinct row per tenant.
--
-- All existing rows are in workspace 'default' (backfilled by 0016); widening a key
-- with a leading workspace_id cannot violate uniqueness (the wider tuple is a
-- superset of the already-unique narrower one). drizzle-kit cannot auto-name a PK to
-- drop, so the three DROP CONSTRAINT use the Postgres default name "<table>_pkey".
ALTER TABLE "annotations" DROP CONSTRAINT "annotations_target_channel_uq";--> statement-breakpoint
ALTER TABLE "dataset_items" DROP CONSTRAINT "dataset_items_dataset_id_trace_id_uq";--> statement-breakpoint
ALTER TABLE "span_evaluations" DROP CONSTRAINT "span_evaluations_span_id_name_uq";--> statement-breakpoint
ALTER TABLE "trace_tags" DROP CONSTRAINT "trace_tags_trace_id_tag_uq";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_pkey";--> statement-breakpoint
ALTER TABLE "spans" DROP CONSTRAINT "spans_pkey";--> statement-breakpoint
ALTER TABLE "traces" DROP CONSTRAINT "traces_pkey";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_session_id_pk" PRIMARY KEY("workspace_id","session_id");--> statement-breakpoint
ALTER TABLE "spans" ADD CONSTRAINT "spans_workspace_id_span_id_pk" PRIMARY KEY("workspace_id","span_id");--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_workspace_id_trace_id_pk" PRIMARY KEY("workspace_id","trace_id");--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_target_channel_uq" UNIQUE("workspace_id","trace_id","span_id","name","annotator_kind");--> statement-breakpoint
ALTER TABLE "dataset_items" ADD CONSTRAINT "dataset_items_dataset_id_trace_id_uq" UNIQUE("workspace_id","dataset_id","trace_id");--> statement-breakpoint
ALTER TABLE "span_evaluations" ADD CONSTRAINT "span_evaluations_span_id_name_uq" UNIQUE("workspace_id","span_id","name");--> statement-breakpoint
ALTER TABLE "trace_tags" ADD CONSTRAINT "trace_tags_trace_id_tag_uq" UNIQUE("workspace_id","trace_id","tag");
