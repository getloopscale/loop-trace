import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Repo-root-relative path to the helper script.
const SCRIPT = fileURLToPath(
  new URL("../../../../scripts/theo-instrument-claude.sh", import.meta.url),
);

function run(args: string[] = []): string {
  return execFileSync("bash", [SCRIPT, ...args], { encoding: "utf8" });
}

describe("theo-instrument-claude.sh (M15)", () => {
  it("test_instrument_script_exports_traces_only_recipe", () => {
    const out = run();
    // traces enabled (+ beta), metrics/logs disabled (Theo ingests spans only).
    expect(out).toMatch(/export CLAUDE_CODE_ENABLE_TELEMETRY=1/);
    expect(out).toMatch(/export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1/);
    expect(out).toMatch(/export OTEL_TRACES_EXPORTER=otlp/);
    expect(out).toMatch(/export OTEL_METRICS_EXPORTER=none/);
    expect(out).toMatch(/export OTEL_LOGS_EXPORTER=none/);
    // default endpoint → the local stack's /v1/traces.
    expect(out).toMatch(
      /export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http:\/\/localhost:4318\/v1\/traces/,
    );
  });

  it("test_instrument_script_honors_custom_endpoint", () => {
    const out = run(["https://lens.example.com"]);
    expect(out).toMatch(
      /export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https:\/\/lens\.example\.com\/v1\/traces/,
    );
  });
});
