CREATE TABLE "annotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trace_id" text NOT NULL,
	"span_id" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"label" text,
	"note" text,
	"annotator_kind" text DEFAULT 'HUMAN' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "annotations_target_channel_uq" UNIQUE("trace_id","span_id","name","annotator_kind")
);
--> statement-breakpoint
CREATE INDEX "annotations_trace_id_idx" ON "annotations" USING btree ("trace_id");