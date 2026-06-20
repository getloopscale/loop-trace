import {
  context,
  SpanStatusCode,
  trace,
  type Span,
  type Tracer,
} from "@opentelemetry/api";

import { GEN_AI } from "./attributes.js";

/** A handle over the active agent span, carrying the tracer for child tool spans. */
export interface AgentSpan {
  readonly raw: Span;
  readonly tracer: Tracer;
  /** Requested model (`gen_ai.request.model`). */
  setModel(model: string): AgentSpan;
  /** Model the provider actually served (`gen_ai.response.model`); M1 prefers this over the requested one. */
  setResponseModel(model: string): AgentSpan;
  setProvider(provider: string): AgentSpan;
  setUsage(usage: { inputTokens?: number; outputTokens?: number }): AgentSpan;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

function wrap(span: Span, tracer: Tracer): AgentSpan {
  const handle: AgentSpan = {
    raw: span,
    tracer,
    setModel(model) {
      span.setAttribute(GEN_AI.REQUEST_MODEL, model);
      return handle;
    },
    setResponseModel(model) {
      span.setAttribute(GEN_AI.RESPONSE_MODEL, model);
      return handle;
    },
    setProvider(provider) {
      span.setAttribute(GEN_AI.SYSTEM, provider);
      return handle;
    },
    setUsage(usage) {
      if (usage.inputTokens != null) {
        span.setAttribute(GEN_AI.USAGE_INPUT_TOKENS, usage.inputTokens);
      }
      if (usage.outputTokens != null) {
        span.setAttribute(GEN_AI.USAGE_OUTPUT_TOKENS, usage.outputTokens);
      }
      return handle;
    },
  };
  return handle;
}

/**
 * Run `fn` inside a `gen_ai` agent span. The span is passed to `fn`; a thrown
 * error is recorded (exception + ERROR status) and re-thrown; the span always
 * ends. Export failures are handled by the processor (fail-open) — they never
 * surface here.
 *
 * Nesting note (M2): child spans nest correctly ONLY when created through this
 * SDK's helpers (e.g. {@link recordToolCall}), because the parent context is
 * rebuilt from the handle. The SDK does NOT call `provider.register()` in M2 (so
 * `initTheoLens` stays side-effect-free and multiple inits / tests stay isolated),
 * which means a bare `tracer.startSpan()` or a third-party OTel instrumentation
 * running inside `fn` will NOT auto-nest under the agent span. Auto-instrumentation
 * (enabling a global context manager) is deferred to a later milestone.
 */
export function startAgent<T>(
  tracer: Tracer,
  name: string,
  fn: (span: AgentSpan) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    name,
    { attributes: { [GEN_AI.OPERATION_NAME]: "chat" } },
    async (span) => {
      try {
        return await fn(wrap(span, tracer));
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Record a tool call as a child span nested under the agent span (EC-1: the
 * parent context is built from the handle, NOT from global state, so nesting
 * works in tests without `provider.register()` and concurrent agents stay isolated).
 */
export function recordToolCall(
  parent: AgentSpan,
  name: string,
  args?: unknown,
): void {
  const ctx = trace.setSpan(context.active(), parent.raw);
  const child = parent.tracer.startSpan(
    name,
    {
      attributes: {
        [GEN_AI.OPERATION_NAME]: "execute_tool",
        [GEN_AI.TOOL_NAME]: name,
        [GEN_AI.TOOL_ARGUMENTS]: safeJson(args),
      },
    },
    ctx,
  );
  child.end();
}
