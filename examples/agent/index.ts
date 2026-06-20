import { initTheoLens, startAgent, recordToolCall } from "@usetheo/lens-sdk";

const endpoint = process.env["THEOLENS_ENDPOINT"] ?? "http://localhost:4318";
// theo:instrument:start — everything between the markers is the instrumentation a
// user writes; the M2 promise is that this body is ≤10 lines (enforced by the e2e).
const theo = initTheoLens({ endpoint, serviceName: "example-agent" });
const traceId = await startAgent(theo.tracer, "checkout", async (span) => {
  span.setModel("gpt-4o").setProvider("openai").setUsage({ inputTokens: 12, outputTokens: 8 });
  recordToolCall(span, "search-products", { query: "running shoes" });
  return span.raw.spanContext().traceId;
});
await theo.shutdown();
// theo:instrument:end
console.log(`THEOLENS_TRACE_ID=${traceId}`); // for the e2e / curl to fetch the trace
