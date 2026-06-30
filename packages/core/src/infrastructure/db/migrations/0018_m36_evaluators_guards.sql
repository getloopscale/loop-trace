CREATE TABLE "evaluators" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"config" jsonb NOT NULL,
	"pass_label" text,
	"fail_label" text,
	"enabled" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evaluators_workspace_id_name_uq" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
CREATE TABLE "guards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"evaluator_id" uuid NOT NULL,
	"operator" text NOT NULL,
	"threshold" double precision,
	"label_value" text,
	"enabled" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guards_workspace_id_dedup_uq" UNIQUE("workspace_id","evaluator_id","operator","threshold","label_value")
);
--> statement-breakpoint
CREATE INDEX "evaluators_workspace_id_idx" ON "evaluators" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "guards_workspace_id_idx" ON "guards" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "guards_evaluator_id_idx" ON "guards" USING btree ("evaluator_id");