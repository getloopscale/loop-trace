CREATE TABLE "eval_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"evaluator_id" uuid NOT NULL,
	"trace_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eval_jobs_workspace_evaluator_trace_uq" UNIQUE("workspace_id","evaluator_id","trace_id")
);
--> statement-breakpoint
ALTER TABLE "evaluators" ADD COLUMN "auto_enabled" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluators" ADD COLUMN "sampling" double precision DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluators" ADD COLUMN "filter" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "eval_jobs_claim_idx" ON "eval_jobs" USING btree ("status","run_after","claimed_at");--> statement-breakpoint
CREATE INDEX "eval_jobs_workspace_id_idx" ON "eval_jobs" USING btree ("workspace_id");