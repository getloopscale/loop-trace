ALTER TABLE "spans" ADD COLUMN "tool_name" text;--> statement-breakpoint
CREATE INDEX "spans_tool_name_idx" ON "spans" USING btree ("tool_name");