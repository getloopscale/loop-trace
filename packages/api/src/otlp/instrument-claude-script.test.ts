import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Repo-root-relative path to the helper script.
const SCRIPT = fileURLToPath(
  new URL("../../../../scripts/looptrace-instrument-claude.sh", import.meta.url),
);

function run(args: string[] = []): string {
  return execFileSync("bash", [SCRIPT, ...args], { encoding: "utf8" });
}

describe("looptrace-instrument-claude.sh (M15)", () => {
  it("test_instrument_script_exports_traces_only_recipe", () => {
    const out = run();
    // traces enabled (+ beta), metrics/logs disabled (LoopTrace ingests spans only).
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
    // no key → no auth header emitted (local stack has no per-tenant edge).
    expect(out).not.toMatch(/OTEL_EXPORTER_OTLP_HEADERS/);
  });

  // M50 — edge mode: a per-tenant `looptrace_live_*` key routes through the unified
  // `/v1/lens` edge (Traefik forward-auth-lens + lens-rewrite `/v1/lens/*` →
  // `/v1/*`), so CC's OTLP traces reach looptrace per-tenant, customer key never
  // reaches the module (Model-B swap at the edge).
  it("test_instrument_script_edge_mode_with_per_tenant_key", () => {
    const out = run(["https://app-dev.getloopscale.com", "looptrace_live_testkey123"]);
    // endpoint uses the EDGE prefix /v1/lens/traces (edge rewrites → /v1/traces)
    expect(out).toMatch(
      /export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https:\/\/app-dev\.getloopscale\.com\/v1\/lens\/traces/,
    );
    // per-tenant key carried as the OTLP Authorization header
    expect(out).toMatch(
      /export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer looptrace_live_testkey123"/,
    );
    // still traces-only + beta
    expect(out).toMatch(/export CLAUDE_CODE_ENABLE_TELEMETRY=1/);
    expect(out).toMatch(/export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1/);
  });

  it("test_instrument_script_rejects_a_key_without_the_live_shape", () => {
    // a key without the `<issuer>_live_*` shape is refused fail-fast (a
    // customer must use their platform key; the edge fail-closes on bad keys).
    expect(() => run(["https://app-dev.getloopscale.com", "sk-wrong-key"])).toThrow();
  });
});
