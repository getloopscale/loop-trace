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

/** Structured ingest log line on stderr (stdout stays clean for piping). */
export function logIngest(spans: number): void {
  console.error(
    JSON.stringify({ level: "info", msg: "spans_ingested", spans }),
  );
}
