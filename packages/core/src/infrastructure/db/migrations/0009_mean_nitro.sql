CREATE TABLE "trace_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" text NOT NULL,
	"tag" text NOT NULL,
	CONSTRAINT "trace_tags_trace_id_tag_uq" UNIQUE("trace_id","tag")
);
--> statement-breakpoint
CREATE INDEX "trace_tags_tag_idx" ON "trace_tags" USING btree ("tag");--> statement-breakpoint
CREATE INDEX "trace_tags_trace_id_idx" ON "trace_tags" USING btree ("trace_id");