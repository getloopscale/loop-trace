/**
 * Runnable sample — record a Claude Code / @theokit/sdk run to Theo Lens in ≤ 10 lines.
 * Feed the buffered `SDKMessage` stream (+ the terminal `RunResult`) to `recordRun`; it translates
 * the run to OTLP and POSTs `/v1/traces`, where the `theokit-sdk` adapter normalizes it.
 *
 * Run against a real engine (or the unified edge, with basePath `/v1/lens`):
 *   LENS_BASE_URL=https://api.usetheo.dev LENS_API_KEY=theo_live_… npx tsx examples/theokit-record-run.ts
 */
import { recordRun, type SDKMessage, type TheokitRunResult } from "@usetheo/lens-sdk";

const baseUrl = process.env["LENS_BASE_URL"];
const apiKey = process.env["LENS_API_KEY"];
if (!baseUrl || !apiKey) {
  console.log("Set LENS_BASE_URL and LENS_API_KEY to run this example against a real engine. Skipping.");
  process.exit(0);
}

// In real code these come from `for await (const msg of run.stream()) messages.push(msg)` + `run.wait()`.
const runId = "example-run-1";
const messages: SDKMessage[] = [
  { type: "system", subtype: "init", agent_id: "my-agent", run_id: runId, model: "claude-opus-4-8", tools: ["Bash"] },
  { type: "user", agent_id: "my-agent", run_id: runId, message: { role: "user", content: [{ type: "text", text: "List the files" }] } },
  { type: "tool_call", agent_id: "my-agent", run_id: runId, call_id: "c1", name: "Bash", status: "completed", args: { command: "ls" }, result: "file.txt\n" },
  { type: "assistant", agent_id: "my-agent", run_id: runId, message: { role: "assistant", content: [{ type: "text", text: "There is one file: file.txt" }] } },
  { type: "status", agent_id: "my-agent", run_id: runId, status: "FINISHED" },
];
const result: TheokitRunResult = { usage: { inputTokens: 210, outputTokens: 15 }, cost: { totalUsd: 0.0031 } };

await recordRun({ messages, result }, { baseUrl, apiKey /*, basePath: "/v1/lens" for the edge */ });
console.log(`Recorded run ${runId} to Theo Lens — open it in the Traces screen.`);
