/**
 * M36 — LLM-judge client (D4). Calls a configurable OpenAI-compatible Chat-Completions
 * endpoint via native `fetch` (no SDK — parsimony rung 2 / Rule 9) and parses a
 * structured {@link Verdict}. FAIL-CLOSED (`error-handling.md`): any non-2xx, network
 * error, unparseable body, out-of-range score (EC-2), or a verdict missing both score
 * AND label (EC-3) throws {@link JudgeError} — NEVER a silent "pass". Injected behind
 * the {@link JudgeClient} interface so the engine is testable with a deterministic stub.
 */
import { z } from "zod";

import type { Verdict } from "./evaluator.js";
import {
  ChatError,
  openaiChatCompletion,
  type ChatConfig,
} from "../provider/chat.js";

/** Typed error for any judge failure — fail-closed, never a silent verdict. */
export class JudgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeError";
  }
}

/** The seam the engine depends on (DIP — real impl or a test stub). */
export interface JudgeClient {
  /** Returns a Verdict or THROWS JudgeError. */
  judge(prompt: string, spanIO: string): Promise<Verdict>;
}

const MAX_SPAN_IO_BYTES = 8 * 1024; // bound the prompt (cost/latency)

const verdictShape = z
  .object({
    score: z.number().optional(),
    label: z.string().optional(),
    explanation: z.string().optional(),
  })
  .strict();

/**
 * Parse the judge model's reply into a Verdict. Strict + fail-closed:
 *  - non-JSON / shape mismatch → JudgeError
 *  - score present but outside [0,1] → JudgeError (EC-2; NO silent clamp)
 *  - neither score nor label → JudgeError (EC-3; explanation alone is not a verdict)
 */
export function parseJudgeVerdict(raw: string): Verdict {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new JudgeError("judge returned unparseable JSON");
  }
  const parsed = verdictShape.safeParse(obj);
  if (!parsed.success) {
    throw new JudgeError("judge verdict shape invalid");
  }
  const v = parsed.data;
  if (v.score != null && (v.score < 0 || v.score > 1)) {
    throw new JudgeError(`judge score ${v.score} out of range [0,1]`);
  }
  if (v.score == null && v.label == null) {
    throw new JudgeError("judge verdict has neither score nor label");
  }
  // Build with only-present keys (exactOptionalPropertyTypes — no `undefined` values).
  const out: Verdict = {};
  if (v.score !== undefined) out.score = v.score;
  if (v.label !== undefined) out.label = v.label;
  if (v.explanation !== undefined) out.explanation = v.explanation;
  return out;
}

/** Provider config — an alias of the shared {@link ChatConfig} (M33 D1). */
export type JudgeConfig = ChatConfig;

/** Truncate span I/O to the prompt budget (UTF-8-safe byte bound). */
function boundSpanIO(spanIO: string): string {
  const buf = Buffer.from(spanIO, "utf8");
  if (buf.byteLength <= MAX_SPAN_IO_BYTES) return spanIO;
  return buf.subarray(0, MAX_SPAN_IO_BYTES).toString("utf8");
}

/**
 * OpenAI-compatible Chat-Completions judge. Delegates the HTTP/content-extraction to
 * the shared {@link openaiChatCompletion} (M33 D1) — mapping its `ChatError` to
 * `JudgeError` so the M36 contract is preserved — then parses a verdict on top.
 */
export class OpenAICompatibleJudge implements JudgeClient {
  constructor(
    private readonly config: JudgeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async judge(prompt: string, spanIO: string): Promise<Verdict> {
    let content: string;
    try {
      content = await openaiChatCompletion(
        this.config,
        [
          { role: "system", content: prompt },
          { role: "user", content: boundSpanIO(spanIO) },
        ],
        this.fetchImpl,
      );
    } catch (err) {
      // Preserve the judge's fail-closed contract (EC-4): any transport/shape failure
      // surfaces as JudgeError, exactly as before the extract.
      throw err instanceof ChatError ? new JudgeError(err.message) : err;
    }
    return parseJudgeVerdict(content);
  }
}
