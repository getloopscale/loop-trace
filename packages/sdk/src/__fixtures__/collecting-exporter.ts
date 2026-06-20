import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";

/**
 * TEST FIXTURE — a duck-typed in-memory span exporter. Used instead of the
 * package's `InMemorySpanExporter` so tests are immune to OTel module-instance
 * duplication (the SDK's `BatchSpanProcessor` and an imported exporter could
 * resolve to different `@opentelemetry/sdk-trace-base` copies). A plain object
 * implementing the `export`/`shutdown` contract works across any copy.
 */
export function collectingExporter(): {
  exporter: SpanExporter;
  spans: ReadableSpan[];
} {
  const spans: ReadableSpan[] = [];
  const exporter: SpanExporter = {
    export(batch, resultCallback) {
      spans.push(...batch);
      resultCallback({ code: 0 }); // 0 = SUCCESS
    },
    shutdown() {
      return Promise.resolve();
    },
  };
  return { exporter, spans };
}

/** A duck-typed exporter whose operations fail — for fail-open tests. */
export function failingExporter(): SpanExporter {
  return {
    export(_batch, resultCallback) {
      resultCallback({ code: 1, error: new Error("boom") }); // 1 = FAILED
    },
    shutdown() {
      return Promise.reject(new Error("shutdown boom"));
    },
    forceFlush() {
      return Promise.reject(new Error("flush boom"));
    },
  };
}

/**
 * A duck-typed exporter whose `export` THROWS synchronously (the harshest
 * adversary for the fail-open contract — a failing exporter callback only
 * reports failure, a synchronous throw could otherwise escape into the flush).
 */
export function throwingExporter(): SpanExporter {
  return {
    export() {
      throw new Error("export boom");
    },
    shutdown() {
      return Promise.resolve();
    },
  };
}

/**
 * A duck-typed exporter whose `export` resolves only after `delayMs` — proves
 * `shutdown()` AWAITS an in-flight flush instead of racing past it.
 */
export function slowExporter(delayMs: number): {
  exporter: SpanExporter;
  spans: ReadableSpan[];
} {
  const spans: ReadableSpan[] = [];
  const exporter: SpanExporter = {
    export(batch, resultCallback) {
      setTimeout(() => {
        spans.push(...batch);
        resultCallback({ code: 0 });
      }, delayMs);
    },
    shutdown() {
      return Promise.resolve();
    },
  };
  return { exporter, spans };
}
