/**
 * The instrumented agent the e2e journey runs against a live stack.
 *
 * It lived at `examples/agent/index.ts` until that directory was retired
 * (675e6cb). The ship gate still needs a real agent to emit real spans, so the
 * agent moved here — into the harness that consumes it — rather than staying a
 * published example nobody maintained.
 *
 * The instrument markers below delimit the body the M2 onboarding promise
 * measures (≤ 10 lines). Everything outside them is harness plumbing (endpoint
 * default, trace-id print) and is deliberately excluded from the count. This
 * comment must not spell the marker tokens out — the counter takes the FIRST
 * line matching each, so a mention up here would swallow the whole preamble.
 */
import { initLoopTrace, startAgent, recordToolCall } from "@looptrace/sdk";

const endpoint = process.env["LOOPTRACE_ENDPOINT"] ?? "http://localhost:4318";
// looptrace:instrument:start — everything between the markers is the instrumentation a
// user writes; the M2 promise is that this body is ≤10 lines (enforced by the e2e).
const looptrace = initLoopTrace({ endpoint, serviceName: "example-agent" });
const traceId = await startAgent(looptrace.tracer, "checkout", async (span) => {
  span.setModel("gpt-4o").setProvider("openai").setUsage({ inputTokens: 12, outputTokens: 8 });
  recordToolCall(span, "search-products", { query: "running shoes" });
  return span.raw.spanContext().traceId;
});
await looptrace.shutdown();
// looptrace:instrument:end
console.log(`LOOPTRACE_TRACE_ID=${traceId}`); // for the e2e / curl to fetch the trace
