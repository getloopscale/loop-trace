CREATE INDEX "sessions_workspace_last_seen_idx" ON "sessions" USING btree ("workspace_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "span_evaluations_workspace_trace_idx" ON "span_evaluations" USING btree ("workspace_id","trace_id");--> statement-breakpoint
CREATE INDEX "spans_workspace_ingested_idx" ON "spans" USING btree ("workspace_id","ingested_at");--> statement-breakpoint
CREATE INDEX "traces_workspace_updated_idx" ON "traces" USING btree ("workspace_id","updated_at");