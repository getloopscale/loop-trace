ALTER TABLE "spans" ADD COLUMN "input_value" text;--> statement-breakpoint
ALTER TABLE "spans" ADD COLUMN "output_value" text;--> statement-breakpoint
ALTER TABLE "spans" ADD COLUMN "events" jsonb;