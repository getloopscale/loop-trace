/**
 * M115 — translate a Claude Code / `@theokit/sdk` `SDKMessage` stream (+ terminal `RunResult`) into
 * an OTLP `resourceSpans` envelope Theo Lens ingests at `POST /v1/traces`. The engine's `theokit-sdk`
 * adapter (selected by `service.name=theokit-sdk`) normalizes it. The mapper is PURE + deterministic
 * (inject `startTimeMs` for tests) and is the shared core M116's native endpoint reuses.
 *
 * Design (blueprint ADRs): emit STANDARD `gen_ai.*` so the default adapter does the base normalization;
 * usage/cost come ONLY from `RunResult` (buffer-then-emit); tool `args`/`result` are unstable → parsed
 * defensively (`unknown` → capped string); `RunResult.cost` is advisory (ADR-4). Missing keys degrade to
 * absent fields — never a throw, never a fabricated value.
 *
 * @public
 */
import { GEN_AI } from "../attributes.js";
import { errorFromReject, errorFromResponse } from "../read/errors.js";
import type { RunResult, SDKMessage, TextBlock, ToolUseBlock } from "./sdk-message.js";

/** service.name that selects the `theokit-sdk` engine adapter. */
export const THEOKIT_SERVICE_NAME = "theokit-sdk";

/** M12-parity cap so a huge tool arg/result never bloats a span (same intent as the engine cap). */
const MAX_ATTR_CHARS = 8192;

type OtlpValue = { stringValue: string } | { intValue: string };
type OtlpAttr = { key: string; value: OtlpValue };
interface OtlpEvent {
  name: string;
  timeUnixNano: string;
  attributes?: OtlpAttr[];
}
interface OtlpSpan {
  spanId: string;
  traceId: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  parentSpanId?: string;
  attributes: OtlpAttr[];
  events?: OtlpEvent[];
  status?: { code: string };
}
export interface OtlpTraces {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttr[] };
    scopeSpans: Array<{ spans: OtlpSpan[] }>;
  }>;
}

export interface SdkMessagesToOtlpOptions {
  /** Base wall-clock (ms) for synthesized span timestamps. Default: 1s ago (avoids the future-trace
   *  read filter). Inject a fixed value for deterministic tests. */
  readonly startTimeMs?: number;
}

const strAttr = (key: string, value: string): OtlpAttr => ({ key, value: { stringValue: value } });
const intAttr = (key: string, value: number): OtlpAttr => ({ key, value: { intValue: String(Math.trunc(value)) } });

/** Coerce an unstable `unknown` (tool args/result) to a capped string, or undefined. */
function capUnknown(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = typeof v === "string" ? v : safeStringify(v);
  if (s === undefined || s.length === 0) return undefined;
  return s.length > MAX_ATTR_CHARS ? s.slice(0, MAX_ATTR_CHARS) : s;
}

function safeStringify(v: unknown): string | undefined {
  try {
    return JSON.stringify(v);
  } catch {
    return undefined; // circular / unserializable → degrade to absent (never throw)
  }
}

/** Deterministic 16-hex span id from a seed (no crypto dep; stable per (run, index)). */
function spanId(seed: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
  }
  return (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).slice(0, 16);
}

const isTextBlock = (b: TextBlock | ToolUseBlock): b is TextBlock => b.type === "text";
const isToolUseBlock = (b: TextBlock | ToolUseBlock): b is ToolUseBlock => b.type === "tool_use";

/**
 * Map an `SDKMessage[]` (+ optional terminal `RunResult`) → an OTLP `resourceSpans` envelope.
 * Pure: no I/O, no wall-clock unless `startTimeMs` is omitted (then `Date.now()` once at call).
 */
export function sdkMessagesToOtlp(
  messages: readonly SDKMessage[],
  runResult?: RunResult,
  opts: SdkMessagesToOtlpOptions = {},
): OtlpTraces {
  const baseMs = opts.startTimeMs ?? Date.now() - 1000;
  const runId = messages.find((m) => "run_id" in m && m.run_id)?.run_id ?? "theokit-run";
  const agentId = messages.find((m) => "agent_id" in m && m.agent_id)?.agent_id;
  const ns = (offsetMs: number): string => `${(baseMs + offsetMs)}000000`;

  // Aggregate the root from system/user/assistant/status.
  const sysInit = messages.find((m): m is Extract<SDKMessage, { type: "system" }> => m.type === "system");
  const userText = messages
    .filter((m): m is Extract<SDKMessage, { type: "user" }> => m.type === "user")
    .flatMap((m) => m.message.content.map((c) => c.text))
    .join("\n");
  const assistantText = messages
    .filter((m): m is Extract<SDKMessage, { type: "assistant" }> => m.type === "assistant")
    .flatMap((m) => m.message.content.filter(isTextBlock).map((c) => c.text))
    .join("\n");
  const terminalStatus = [...messages].reverse().find(
    (m): m is Extract<SDKMessage, { type: "status" }> => m.type === "status",
  );

  const rootId = spanId(`${runId}:root`);
  const rootAttrs: OtlpAttr[] = [];
  // `model` is a `ModelSelection` ({id,params}) on the wire, or a bare string — extract the id.
  const modelId = typeof sysInit?.model === "string" ? sysInit.model : sysInit?.model?.id;
  if (modelId) rootAttrs.push(strAttr(GEN_AI.REQUEST_MODEL, modelId));
  if (agentId) {
    rootAttrs.push(strAttr("agent.id", agentId), strAttr("agent.name", agentId));
  }
  if (sysInit?.tools?.length) rootAttrs.push(strAttr("theokit.tools", sysInit.tools.join(",")));
  const capUser = capUnknown(userText);
  if (capUser) rootAttrs.push(strAttr(GEN_AI.INPUT_VALUE, capUser));
  const capAsst = capUnknown(assistantText);
  if (capAsst) rootAttrs.push(strAttr(GEN_AI.OUTPUT_VALUE, capAsst));
  // Usage/cost — ONLY from the terminal RunResult (never fabricated when absent).
  const u = runResult?.usage;
  if (typeof u?.inputTokens === "number") rootAttrs.push(intAttr(GEN_AI.USAGE_INPUT_TOKENS, u.inputTokens));
  if (typeof u?.outputTokens === "number") rootAttrs.push(intAttr(GEN_AI.USAGE_OUTPUT_TOKENS, u.outputTokens));
  if (typeof u?.cacheReadInputTokens === "number") rootAttrs.push(intAttr("gen_ai.usage.cache_read_input_tokens", u.cacheReadInputTokens));
  if (typeof u?.cacheCreationInputTokens === "number") rootAttrs.push(intAttr("gen_ai.usage.cache_creation_input_tokens", u.cacheCreationInputTokens));
  if (typeof runResult?.cost?.totalUsd === "number") rootAttrs.push(strAttr("theokit.cost.usd", String(runResult.cost.totalUsd)));

  const rootErrored = terminalStatus?.status === "ERROR";
  const spans: OtlpSpan[] = [
    {
      spanId: rootId,
      traceId: runId,
      name: sysInit?.model ? "agent.run" : (agentId ?? "agent.run"),
      startTimeUnixNano: ns(0),
      endTimeUnixNano: ns(1),
      attributes: rootAttrs,
      ...(rootErrored ? { status: { code: "STATUS_CODE_ERROR" } } : {}),
    },
  ];

  // Child spans: tool_call lifecycle + assistant tool_use blocks + thinking.
  let offset = 2;
  for (const m of messages) {
    if (m.type === "tool_call" && (m.status === "completed" || m.status === "error")) {
      const attrs: OtlpAttr[] = [strAttr(GEN_AI.TOOL_NAME, m.name)];
      const capArgs = capUnknown(m.args);
      if (capArgs) attrs.push(strAttr(GEN_AI.INPUT_VALUE, capArgs));
      const capResult = capUnknown(m.result);
      const events: OtlpEvent[] | undefined = capResult
        ? [{ name: "tool.output", timeUnixNano: ns(offset), attributes: [strAttr("output", capResult)] }]
        : undefined;
      spans.push({
        spanId: spanId(`${runId}:tool:${m.call_id}`),
        traceId: runId,
        parentSpanId: rootId,
        name: m.name,
        startTimeUnixNano: ns(offset),
        endTimeUnixNano: ns(offset + 1),
        attributes: attrs,
        ...(events ? { events } : {}),
        ...(m.status === "error" ? { status: { code: "STATUS_CODE_ERROR" } } : {}),
      });
      offset += 2;
    } else if (m.type === "assistant") {
      for (const block of m.message.content.filter(isToolUseBlock)) {
        const attrs: OtlpAttr[] = [strAttr(GEN_AI.TOOL_NAME, block.name)];
        const capInput = capUnknown(block.input);
        if (capInput) attrs.push(strAttr(GEN_AI.INPUT_VALUE, capInput));
        spans.push({
          spanId: spanId(`${runId}:tooluse:${block.id}`),
          traceId: runId,
          parentSpanId: rootId,
          name: block.name,
          startTimeUnixNano: ns(offset),
          endTimeUnixNano: ns(offset + 1),
          attributes: attrs,
        });
        offset += 2;
      }
    } else if (m.type === "thinking") {
      const attrs: OtlpAttr[] = [];
      if (typeof m.thinking_duration_ms === "number") attrs.push(intAttr("theokit.thinking.duration_ms", m.thinking_duration_ms));
      const capThink = capUnknown(m.text);
      if (capThink) attrs.push(strAttr(GEN_AI.OUTPUT_VALUE, capThink));
      spans.push({
        spanId: spanId(`${runId}:thinking:${offset}`),
        traceId: runId,
        parentSpanId: rootId,
        name: "thinking",
        startTimeUnixNano: ns(offset),
        endTimeUnixNano: ns(offset + 1),
        attributes: attrs,
      });
      offset += 2;
    }
    // object_delta / request / task / user / system / status: handled at the root or intentionally
    // not span-mapped (documented) — never a throw.
  }

  return {
    resourceSpans: [
      { resource: { attributes: [strAttr("service.name", THEOKIT_SERVICE_NAME)] }, scopeSpans: [{ spans }] },
    ],
  };
}

/** A completed (or terminal-state) run to record: the buffered `SDKMessage`s + optional `RunResult`. */
export interface TheokitRun {
  readonly messages: readonly SDKMessage[];
  readonly result?: RunResult;
}

export interface RecordRunOptions {
  /** Engine or edge base URL, e.g. `https://app.usetheo.dev` (no trailing slash). */
  readonly baseUrl: string;
  /** A `theo_live_*` per-tenant key. Sent as `Authorization: Bearer <apiKey>` (`observability:write`). */
  readonly apiKey: string;
  /** Path root. Default `/v1`; consumers behind the unified edge set `/v1/lens` (the #49 fix). */
  readonly basePath?: string;
  /** Injected `fetch` (tests pass the in-process engine `app.fetch`). */
  readonly fetch?: typeof fetch;
  /** Deterministic base timestamp (ms) forwarded to the mapper. */
  readonly startTimeMs?: number;
}

/**
 * Record a Claude Code / `@theokit/sdk` run to Theo Lens.
 *
 * Prefers the NATIVE `POST /v1/runs` endpoint (M116): it takes the raw `SDKMessage` batch
 * (`{ messages, result, startTimeMs }`) and maps it to spans server-side with the SAME
 * `sdkMessagesToOtlp` mapper the SDK owns — so the SDK carries no OTLP knowledge on the happy path.
 * When the engine has NOT deployed `/v1/runs` (older cloud / self-hosted) it answers `404`/`405`; on
 * either status `recordRun` falls back to `POST /v1/traces` with the client-side OTLP envelope (the
 * pre-M116 path). Both paths run the identical mapper, so read-back is byte-identical (ADR D2).
 *
 * The `startTimeMs` seam is forwarded on BOTH paths (in the `/v1/runs` body, and into the client-side
 * mapper for the `/v1/traces` fallback) so a deterministic test observes identical timestamps either way.
 *
 * OTLP ingest is idempotent server-side (span dedup on `(workspace, span_id)`) and a `/v1/runs` that
 * 404'd never persisted, so the fallback cannot double-write. Throws `LensApiError` on a non-2xx that is
 * not the `/v1/runs`-absent signal, or on a network reject — never swallows.
 *
 * @public
 */
export async function recordRun(run: TheokitRun, opts: RecordRunOptions): Promise<void> {
  if (!opts.apiKey) throw new Error("recordRun: apiKey is required");
  const base = opts.basePath ?? "/v1";
  const doFetch = opts.fetch ?? fetch;
  const headers = { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" };

  /** POST a JSON body to `${base}${suffix}`; throws a typed error on a non-2xx or a network reject. */
  const post = async (suffix: string, body: unknown): Promise<Response> => {
    const path = `${base}${suffix}`;
    try {
      return await doFetch(`${opts.baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (e) {
      throw errorFromReject(e, "POST", path);
    }
  };

  // Native /v1/runs first: the engine owns the SDKMessage→OTLP mapping (no client OTLP knowledge).
  const runsBody = {
    messages: run.messages,
    ...(run.result !== undefined ? { result: run.result } : {}),
    ...(opts.startTimeMs !== undefined ? { startTimeMs: opts.startTimeMs } : {}),
  };
  const runsRes = await post("/runs", runsBody);
  if (runsRes.ok) return;
  // 404/405 = the engine has not deployed /v1/runs → fall back to the OTLP /v1/traces path.
  if (runsRes.status !== 404 && runsRes.status !== 405) {
    throw await errorFromResponse(runsRes, "POST", `${base}/runs`);
  }

  // Fallback: translate to OTLP client-side and POST /v1/traces (the pre-M116 path).
  const otlp = sdkMessagesToOtlp(run.messages, run.result, opts.startTimeMs !== undefined ? { startTimeMs: opts.startTimeMs } : {});
  const tracesRes = await post("/traces", otlp);
  if (tracesRes.status >= 400) throw await errorFromResponse(tracesRes, "POST", `${base}/traces`);
}
