CREATE TABLE "session_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"session_id" text NOT NULL,
	"name" text NOT NULL,
	"verdict" text NOT NULL,
	"score" double precision,
	"reasoning" text,
	"model" text,
	"session_version" text NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_evaluations_session_id_name_uq" UNIQUE("workspace_id","session_id","name")
);
--> statement-breakpoint
CREATE INDEX "session_evaluations_name_idx" ON "session_evaluations" USING btree ("name");--> statement-breakpoint
CREATE INDEX "session_evaluations_workspace_session_idx" ON "session_evaluations" USING btree ("workspace_id","session_id");