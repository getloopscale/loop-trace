/**
 * @looptrace/api barrel — the public ingestion contract other packages verify
 * against. `parseResourceSpans` is the canonical OTLP envelope → domain-span
 * mapper used by the receiver; exporting it lets the SDK's contract test prove
 * its output is accepted by the REAL M1 parser (not a hand-rolled stand-in).
 */
export { parseResourceSpans } from "./otlp/parse-resource-spans.js";

/**
 * The live OpenAPI document builder + the app factory that yields the mounted route
 * table. Exported for dev/test tooling (the read-SDK's type generator + drift gate build
 * the spec from `createApp(stub).routes` — same test-only coupling rationale as
 * `parseResourceSpans` above). Not part of the runtime ingestion contract.
 */
export { createApp } from "./server/app.js";
export { buildOpenApiDocument, type MountedRoute } from "./server/openapi.js";
