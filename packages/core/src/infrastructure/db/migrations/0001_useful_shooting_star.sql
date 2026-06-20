CREATE TABLE "sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "traces" (
	"trace_id" text PRIMARY KEY NOT NULL,
	"session_id" text,
	"name" text,
	"start_time_unix_nano" text,
	"end_time_unix_nano" text,
	"status_code" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"total_tokens" integer,
	"cost_usd" double precision,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spans" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "spans" ADD COLUMN "status_message" text;--> statement-breakpoint
ALTER TABLE "spans" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "spans" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "spans" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "spans" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "spans" ADD COLUMN "session_id" text;--> statement-breakpoint
CREATE INDEX "traces_session_id_idx" ON "traces" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "spans_parent_span_id_idx" ON "spans" USING btree ("parent_span_id");