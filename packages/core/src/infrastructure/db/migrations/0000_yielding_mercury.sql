CREATE TABLE "spans" (
	"span_id" text PRIMARY KEY NOT NULL,
	"trace_id" text NOT NULL,
	"parent_span_id" text,
	"name" text NOT NULL,
	"start_time_unix_nano" text NOT NULL,
	"end_time_unix_nano" text NOT NULL,
	"status_code" text,
	"attributes" jsonb,
	"ingested_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "spans_trace_id_idx" ON "spans" USING btree ("trace_id");