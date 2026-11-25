import { describe, it, expect } from "vitest";
import { initLoopTrace } from "./sdk.js";
import {
  collectingExporter,
  failingExporter,
  slowExporter,
} from "./__fixtures__/collecting-exporter.js";

describe("initLoopTrace", () => {
  it("init_returns_tracer_and_shutdown", () => {
    const { exporter } = collectingExporter();
    const looptrace = initLoopTrace({ endpoint: "http://localhost:4318", serviceName: "t", exporter });
    expect(typeof looptrace.tracer.startSpan).toBe("function");
    expect(typeof looptrace.shutdown).toBe("function");
  });

  it("shutdown_flushes_buffered_spans_to_exporter", async () => {
    const { exporter, spans } = collectingExporter();
    const looptrace = initLoopTrace({ endpoint: "http://x", serviceName: "t", exporter });
    looptrace.tracer.startSpan("s").end();
    await looptrace.shutdown();
    expect(spans.map((s) => s.name)).toContain("s");
  });

  it("shutdown_resolves_even_when_exporter_flush_fails", async () => {
    // Fail-open (EC-2): a telemetry-backend outage at shutdown must not crash the app.
    const looptrace = initLoopTrace({ endpoint: "http://x", serviceName: "t", exporter: failingExporter() });
    looptrace.tracer.startSpan("s").end();
    await expect(looptrace.shutdown()).resolves.toBeUndefined();
  });

  it("shutdown_awaits_a_slow_in_flight_flush_before_resolving", async () => {
    // A delayed exporter is collected only if shutdown() AWAITS forceFlush rather
    // than racing past it (covers Failure-scenarios row 2: slow flush at shutdown).
    const { exporter, spans } = slowExporter(50);
    const looptrace = initLoopTrace({ endpoint: "http://x", serviceName: "t", exporter });
    looptrace.tracer.startSpan("s").end();
    await looptrace.shutdown();
    expect(spans.map((x) => x.name)).toContain("s");
  });
});
