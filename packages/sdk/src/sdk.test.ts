import { describe, it, expect } from "vitest";
import { initTheoLens } from "./sdk.js";
import { collectingExporter, failingExporter } from "./__fixtures__/collecting-exporter.js";

describe("initTheoLens", () => {
  it("init_returns_tracer_and_shutdown", () => {
    const { exporter } = collectingExporter();
    const theo = initTheoLens({ endpoint: "http://localhost:4318", serviceName: "t", exporter });
    expect(typeof theo.tracer.startSpan).toBe("function");
    expect(typeof theo.shutdown).toBe("function");
  });

  it("shutdown_flushes_buffered_spans_to_exporter", async () => {
    const { exporter, spans } = collectingExporter();
    const theo = initTheoLens({ endpoint: "http://x", serviceName: "t", exporter });
    theo.tracer.startSpan("s").end();
    await theo.shutdown();
    expect(spans.map((s) => s.name)).toContain("s");
  });

  it("shutdown_resolves_even_when_exporter_flush_fails", async () => {
    // Fail-open (EC-2): a telemetry-backend outage at shutdown must not crash the app.
    const theo = initTheoLens({ endpoint: "http://x", serviceName: "t", exporter: failingExporter() });
    theo.tracer.startSpan("s").end();
    await expect(theo.shutdown()).resolves.toBeUndefined();
  });
});
