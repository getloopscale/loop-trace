CREATE TABLE "experiment_run_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"run_id" uuid NOT NULL,
	"dataset_item_trace_id" text NOT NULL,
	"input_snapshot" text,
	"output" text,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" double precision,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"scores" jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experiment_run_items_workspace_run_trace_uq" UNIQUE("workspace_id","run_id","dataset_item_trace_id")
);
--> statement-breakpoint
CREATE TABLE "experiment_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"dataset_id" uuid NOT NULL,
	"name" text NOT NULL,
	"variant" jsonb NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"pass_count" integer DEFAULT 0 NOT NULL,
	"avg_score" double precision,
	"total_cost_usd" double precision DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "experiment_run_items_run_idx" ON "experiment_run_items" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "experiment_runs_workspace_dataset_idx" ON "experiment_runs" USING btree ("workspace_id","dataset_id");--> statement-breakpoint
CREATE INDEX "experiment_runs_workspace_created_idx" ON "experiment_runs" USING btree ("workspace_id","created_at");