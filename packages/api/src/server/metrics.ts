/**
 * Minimal runtime observability for M0 (wiring-triad pillar c). A process-local
 * counter + a structured log line per ingest. Kept deliberately tiny (YAGNI) —
 * full OTel self-instrumentation is a later milestone. The counter is exported so
 * integration/e2e tests can assert ingestion actually fired.
 */
function counter() {
  let n = 0;
  return {
    add(delta: number): void {
      n += delta;
    },
    get value(): number {
      return n;
    },
    reset(): void {
      n = 0;
    },
  };
}

export const spansIngested = counter();
export const tracesIngested = counter();
// M93: spans dropped at ingest for failing validation (OTLP partial-success). A distinct counter so
// "producer sending malformed spans" is visible at runtime, never a silent drop (data-honesty).
export const spansRejected = counter();
// M93: ingest requests shed by the per-workspace backpressure limiter (429).
export const ingestRateLimited = counter();
// M26: online-eval results extracted from `eval.*` span attributes at ingest. A
// distinct counter so "no evals on the Evals page" is distinguishable at runtime
// from "evals arrived but extraction dropped them" (wiring-triad pillar c).
export const evaluationsExtracted = counter();
// M26b: human-feedback annotations written via the API (upserts). A distinct
// counter so feedback-write volume is observable at runtime (wiring-triad pillar c).
export const annotationsWritten = counter();
// M26d: dataset items added via the API. Distinct counter so curation volume is
// observable at runtime (wiring-triad pillar c).
export const datasetItemsAdded = counter();
// M63: labeling-queue lifecycle. Distinct counters so the review funnel is observable at
// runtime (wiring-triad pillar c): spans enqueued vs items resolved vs golden-dataset exports.
export const labelingItemsEnqueued = counter();
export const labelingItemsResolved = counter();
export const labelingQueueExports = counter();
// M33: "Ask about this step" copilot. Distinct counters so ops can see, at runtime,
// answered asks vs the two fail-closed states — a rate-limited spike (abuse) and a
// provider-unavailable spike (outage) are distinguishable from healthy usage
// (wiring-triad pillar c). A cost-bearing + abuse-prone endpoint MUST be observable.
export const copilotAsksAnswered = counter();
export const copilotAsksRateLimited = counter();
export const copilotAsksUnavailable = counter();
// M83 — copilot answer feedback volume (thumbs up/down recorded) is observable at runtime (pillar c).
export const copilotFeedbackRecorded = counter();

// M55 span-replay — a billable, abuse-prone provider call MUST be observable so a healthy replay
// volume, a rate-limit spike, and a provider-outage spike are distinguishable (wiring-triad pillar c).
export const replayRuns = counter();
export const replayRateLimited = counter();
export const replayUnavailable = counter();
// M64: experiment runs. Distinct counters so the experiment funnel is observable at runtime
// (wiring-triad pillar c): runs started vs rows scored vs runs that failed closed.
export const experimentRunsStarted = counter();
export const experimentRowsScored = counter();
export const experimentRunsUnavailable = counter();

// M118 — runtime metrics on the advanced write routes that emitted none. Exported so integration tests
// can assert `.value` deltas (wiring-triad pillar c); one `.add(1)` per route in the handler.
// evaluator-run FIRST (billable — top priority): the run limiter shed count + the runs-started count.
export const evaluatorRunRateLimited = counter();
export const evaluatorRunsStarted = counter();
// Evaluator / guard definition CRUD (create) — curation volume is observable at runtime.
export const evaluatorsCreated = counter();
export const guardsCreated = counter();
// Dataset lifecycle mutations (create / rename / delete / item-remove) — the add path already has
// `datasetItemsAdded`; these close the remaining mutating verbs.
export const datasetsCreated = counter();
export const datasetsRenamed = counter();
export const datasetsDeleted = counter();
export const datasetItemsRemoved = counter();
// Tag add/remove + annotation remove (the annotation WRITE already has `annotationsWritten`).
export const tagsAdded = counter();
export const tagsRemoved = counter();
export const annotationsRemoved = counter();
// Replay-session north-star record (M8) — the mutating write emitted no counter until M118.
export const replaySessionsRecorded = counter();

/** Structured ingest log line on stderr (stdout stays clean for piping). */
export function logIngest(spans: number, evals = 0): void {
  console.error(
    JSON.stringify({ level: "info", msg: "spans_ingested", spans, evals }),
  );
}

// M134 auto-evaluation. Label-less counters asserted from tests, exactly like
// `spansIngested` — this repo has no /metrics endpoint and no label dimension,
// and inventing one would have added a runtime dependency the plan forbids (EC-1).
/** Auto-eval jobs that finished successfully. The milestone's success metric. */
export const autoEvalJobsCompleted = counter();
/** Auto-eval jobs that failed. Distinguishes "not running" from "running badly". */
export const autoEvalJobsFailed = counter();
/**
 * Enqueues dropped at ingest.
 *
 * The enqueue is deliberately fire-and-forget so it can never fail an ingest
 * (D5), which means a drop is otherwise INVISIBLE — exactly blueprint AP-3,
 * where the reference logs and returns and the eval is silently lost forever.
 * This counter is what makes the drop observable.
 */
export const autoEvalEnqueueFailures = counter();
/**
 * Jobs settled without evaluating — the evaluator was deleted between enqueue
 * and claim.
 *
 * Deliberately NOT folded into `autoEvalJobsCompleted`. The milestone's success
 * metric is that counter; letting it absorb work that never ran would make the
 * one number the goal rests on quietly untrue. A rising value here is also a
 * real signal on its own: evaluators being deleted while their work is queued.
 */
export const autoEvalJobsOrphaned = counter();
