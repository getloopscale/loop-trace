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

/** Structured ingest log line on stderr (stdout stays clean for piping). */
export function logIngest(spans: number, evals = 0): void {
  console.error(
    JSON.stringify({ level: "info", msg: "spans_ingested", spans, evals }),
  );
}
