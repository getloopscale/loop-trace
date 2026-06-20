/**
 * @usetheo/lens-api barrel — the public ingestion contract other packages verify
 * against. `parseResourceSpans` is the canonical OTLP envelope → domain-span
 * mapper used by the receiver; exporting it lets the SDK's contract test prove
 * its output is accepted by the REAL M1 parser (not a hand-rolled stand-in).
 */
export { parseResourceSpans } from "./otlp/parse-resource-spans.js";
