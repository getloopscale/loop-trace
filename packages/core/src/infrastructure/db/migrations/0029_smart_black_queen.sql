DROP INDEX "eval_jobs_claim_idx";--> statement-breakpoint
CREATE INDEX "eval_jobs_runnable_idx" ON "eval_jobs" USING btree ("run_after") WHERE "eval_jobs"."status" IN ('queued', 'running');