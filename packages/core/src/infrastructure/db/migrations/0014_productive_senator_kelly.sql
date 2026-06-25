CREATE TABLE "dataset_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dataset_id" uuid NOT NULL,
	"trace_id" text NOT NULL,
	"input_snapshot" text,
	"output_snapshot" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dataset_items_dataset_id_trace_id_uq" UNIQUE("dataset_id","trace_id")
);
--> statement-breakpoint
CREATE TABLE "datasets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "datasets_name_uq" UNIQUE("name")
);
--> statement-breakpoint
CREATE INDEX "dataset_items_dataset_id_idx" ON "dataset_items" USING btree ("dataset_id");