import { initTheoLens, startAgent, recordToolCall } from "@usetheo/lens-sdk";

const endpoint = process.env["THEOLENS_ENDPOINT"] ?? "http://localhost:4318";
const theo = initTheoLens({ endpoint, serviceName: "example-agent" });
let traceId = "";
await startAgent(theo.tracer, "checkout", async (span) => {
  traceId = span.raw.spanContext().traceId;
  span.setModel("gpt-4o").setProvider("openai").setUsage({ inputTokens: 12, outputTokens: 8 });
  recordToolCall(span, "search-products", { query: "running shoes" });
});
await theo.shutdown();
console.log(`THEOLENS_TRACE_ID=${traceId}`); // for the e2e / curl to fetch the trace
