# Example: instrument an agent in ≤10 lines

This shows the full Theo Lens onboarding: instrument a TS/Node agent and have its
spans ingested by Theo Lens.

## Run it

1. Start the stack (`docker compose up`) — the OTLP ingestion listens on `:4318`.
2. Run the example:

   ```bash
   THEOLENS_ENDPOINT=http://localhost:4318 pnpm tsx examples/agent/index.ts
   ```

3. It prints `THEOLENS_TRACE_ID=<id>`; open the trace:

   ```bash
   curl http://localhost:4318/v1/traces/<id>
   ```

## The ≤10-line instrumentation

```ts
import { initTheoLens, startAgent, recordToolCall } from "@usetheo/lens-sdk";

const theo = initTheoLens({ endpoint: "http://localhost:4318", serviceName: "example-agent" });
await startAgent(theo.tracer, "checkout", async (span) => {
  span.setModel("gpt-4o").setProvider("openai").setUsage({ inputTokens: 12, outputTokens: 8 });
  recordToolCall(span, "search-products", { query: "running shoes" });
});
await theo.shutdown(); // flushes buffered spans before exit
```

- `initTheoLens` wires the OpenTelemetry tracer + OTLP exporter — no boilerplate.
- `startAgent` opens a `gen_ai` span; `setModel/setProvider/setUsage` emit the
  standard `gen_ai.*` attributes Theo Lens reads into typed columns.
- `recordToolCall` records a nested tool span.
- `await shutdown()` flushes — **always call it before the process exits**, or
  buffered spans are dropped.

## Nesting scope (M2)

Spans nest correctly when created through the SDK helpers (`startAgent`,
`recordToolCall`) — they rebuild the parent context from the handle. The SDK does
**not** install a global OpenTelemetry context manager in M2 (so `initTheoLens` is
side-effect-free and multiple inits / tests stay isolated), so a bare
`tracer.startSpan()` or a third-party OTel auto-instrumentation running inside your
agent function will **not** auto-nest under the agent span. Automatic context
propagation (auto-instrumenting LLM client libraries) is planned for a later
milestone.
