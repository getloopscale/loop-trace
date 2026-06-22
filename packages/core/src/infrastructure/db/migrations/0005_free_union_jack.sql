CREATE INDEX "spans_model_idx" ON "spans" USING btree ("model");--> statement-breakpoint
CREATE INDEX "traces_status_code_idx" ON "traces" USING btree ("status_code");