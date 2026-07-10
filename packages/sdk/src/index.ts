/**
 * @usetheo/lens-sdk — instrument a TS/Node agent in ≤10 lines; emit OTLP gen_ai
 * spans to Theo Lens. Thin facade over the OpenTelemetry JS SDK.
 */
export { initTheoLens, type TheoLens, type InitOptions } from "./sdk.js";
export { startAgent, recordToolCall, type AgentSpan } from "./agent-span.js";
export { GEN_AI } from "./attributes.js";

// M103 — the typed READ surface: read traces/metrics/sessions/etc. back via a `theo_live_*` key.
export { LensReadClient, type LensReadClientOptions } from "./read/client.js";
// M104 — the single typed error every read method can throw (switch on `.code`).
export { LensApiError, type FieldIssue } from "./read/errors.js";
export type {
  TraceListResponse,
  Span,
  ObservabilityResponse,
  SessionListResponse,
  CostByPeriodResponse,
  ToolStatsResponse,
  Dataset,
  ListTracesOptions,
  ListSessionsOptions,
  ObservabilityOptions,
  CostByPeriodOptions,
} from "./read/types.js";
