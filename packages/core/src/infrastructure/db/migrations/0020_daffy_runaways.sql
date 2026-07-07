CREATE TABLE "labeling_queue_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"trace_id" text NOT NULL,
	"span_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"label" text,
	"score" double precision,
	"note" text,
	"resolution_version" integer,
	"created_by" text NOT NULL,
	"resolved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "labeling_queue_items_workspace_trace_span_uq" UNIQUE("workspace_id","trace_id","span_id")
);
--> statement-breakpoint
CREATE INDEX "labeling_queue_items_workspace_status_idx" ON "labeling_queue_items" USING btree ("workspace_id","status");