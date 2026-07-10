CREATE TABLE "copilot_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"trace_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"span_id" text DEFAULT '' NOT NULL,
	"label" text NOT NULL,
	"question" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copilot_feedback_turn_uq" UNIQUE("workspace_id","trace_id","turn_id")
);
--> statement-breakpoint
CREATE INDEX "copilot_feedback_trace_id_idx" ON "copilot_feedback" USING btree ("trace_id");