CREATE TABLE "looptrace_api_keys" (
	"id" varchar(20) PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"tenant_id" text DEFAULT 'self' NOT NULL,
	"workspace_id" text DEFAULT 'default' NOT NULL,
	"user_id" text,
	"key_name" varchar(64) NOT NULL,
	"key_hash" varchar(64) NOT NULL,
	"key_prefix" varchar(12) NOT NULL,
	"scopes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"rotated_from" varchar(20),
	CONSTRAINT "looptrace_api_keys_key_hash_uq" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "workspace_users" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	CONSTRAINT "workspace_users_pk" UNIQUE("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "datasets" DROP CONSTRAINT "datasets_name_uq";--> statement-breakpoint
ALTER TABLE "annotations" ADD COLUMN "workspace_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "dataset_items" ADD COLUMN "workspace_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "datasets" ADD COLUMN "workspace_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "replay_sessions" ADD COLUMN "workspace_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "workspace_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "span_evaluations" ADD COLUMN "workspace_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "spans" ADD COLUMN "workspace_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "trace_tags" ADD COLUMN "workspace_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "traces" ADD COLUMN "workspace_id" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX "looptrace_api_keys_subject_tenant_idx" ON "looptrace_api_keys" USING btree ("subject","tenant_id");--> statement-breakpoint
CREATE INDEX "looptrace_api_keys_workspace_id_idx" ON "looptrace_api_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "workspace_users_workspace_id_idx" ON "workspace_users" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "sessions_workspace_id_idx" ON "sessions" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "spans_workspace_id_idx" ON "spans" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "traces_workspace_id_idx" ON "traces" USING btree ("workspace_id");--> statement-breakpoint
ALTER TABLE "datasets" ADD CONSTRAINT "datasets_workspace_id_name_uq" UNIQUE("workspace_id","name");--> statement-breakpoint
-- M22 seed: the `default` workspace + `default-owner` (single-tenant collapse).
INSERT INTO "workspaces" ("id", "name") VALUES ('default', 'Default workspace') ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "workspace_users" ("workspace_id", "user_id", "role") VALUES ('default', 'default-owner', 'owner') ON CONFLICT DO NOTHING;
