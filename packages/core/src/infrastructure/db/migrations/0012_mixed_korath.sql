CREATE TABLE "span_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"span_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"name" text NOT NULL,
	"score" double precision,
	"label" text,
	"explanation" text,
	CONSTRAINT "span_evaluations_span_id_name_uq" UNIQUE("span_id","name")
);
--> statement-breakpoint
CREATE INDEX "span_evaluations_name_idx" ON "span_evaluations" USING btree ("name");--> statement-breakpoint
CREATE INDEX "span_evaluations_trace_id_idx" ON "span_evaluations" USING btree ("trace_id");