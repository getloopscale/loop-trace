/**
 * Minimal runtime observability for M0 (wiring-triad pillar c). A process-local
 * counter + a structured log line per ingest. Kept deliberately tiny (YAGNI) —
 * full OTel self-instrumentation is a later milestone. The counter is exported so
 * integration/e2e tests can assert ingestion actually fired.
 */
let ingested = 0;

export const spansIngested = {
  add(n: number): void {
    ingested += n;
  },
  get value(): number {
    return ingested;
  },
  reset(): void {
    ingested = 0;
  },
};

/** Structured ingest log line on stderr (stdout stays clean for piping). */
export function logIngest(spans: number): void {
  console.error(
    JSON.stringify({ level: "info", msg: "spans_ingested", spans }),
  );
}
