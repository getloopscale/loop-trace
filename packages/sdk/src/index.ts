/**
 * @usetheo/lens-sdk — instrument a TS/Node agent in ≤10 lines; emit OTLP gen_ai
 * spans to Theo Lens. Thin facade over the OpenTelemetry JS SDK.
 */
export { initTheoLens, type TheoLens, type InitOptions } from "./sdk.js";
export { startAgent, recordToolCall, type AgentSpan } from "./agent-span.js";
export { GEN_AI } from "./attributes.js";
