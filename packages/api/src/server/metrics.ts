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

/** Structured ingest log line on stderr (stdout stays clean for piping). */
export function logIngest(spans: number, evals = 0): void {
  console.error(
    JSON.stringify({ level: "info", msg: "spans_ingested", spans, evals }),
  );
}
