import type { Tracer } from "@opentelemetry/api";
import {
  BatchSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export interface InitOptions {
  /** Theo Lens base URL, e.g. "http://localhost:4318". `/v1/traces` is appended. */
  endpoint: string;
  /** service.name resource attribute for the agent. */
  serviceName: string;
  /** Inject a custom exporter (used by tests; defaults to the OTLP/HTTP exporter). */
  exporter?: SpanExporter;
}

export interface TheoLens {
  tracer: Tracer;
  /** Flush buffered spans and shut down. Resolves even if the flush fails (EC-2). */
  shutdown(): Promise<void>;
}

function logError(stage: string, err: unknown): void {
  // Fail-open: a telemetry-backend problem must never crash the instrumented app.
  console.error(
    JSON.stringify({
      level: "error",
      msg: "theo_lens_sdk_error",
      stage,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}

/**
 * Initialize Theo Lens instrumentation. Encapsulates the OTel tracer provider +
 * OTLP exporter + batch processor so user code is ≤10 lines and never writes
 * flush boilerplate. Call `await shutdown()` before the process exits so buffered
 * spans are flushed (BatchSpanProcessor would otherwise drop them).
 */
export function initTheoLens(opts: InitOptions): TheoLens {
  const url = `${opts.endpoint.replace(/\/+$/, "")}/v1/traces`;
  const exporter = opts.exporter ?? new OTLPTraceExporter({ url });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: opts.serviceName }),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });

  return {
    tracer: provider.getTracer("@usetheo/lens-sdk"),
    async shutdown(): Promise<void> {
      try {
        await provider.forceFlush();
      } catch (err) {
        logError("forceFlush", err);
      }
      try {
        await provider.shutdown();
      } catch (err) {
        logError("shutdown", err);
      }
    },
  };
}
