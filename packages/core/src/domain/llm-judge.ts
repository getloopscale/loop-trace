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

export interface JudgeConfig {
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
}

/** Truncate span I/O to the prompt budget (UTF-8-safe byte bound). */
function boundSpanIO(spanIO: string): string {
  const buf = Buffer.from(spanIO, "utf8");
  if (buf.byteLength <= MAX_SPAN_IO_BYTES) return spanIO;
  return buf.subarray(0, MAX_SPAN_IO_BYTES).toString("utf8");
}

/** OpenAI-compatible Chat-Completions judge. Pins temperature 0 for reproducibility. */
export class OpenAICompatibleJudge implements JudgeClient {
  constructor(
    private readonly config: JudgeConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async judge(prompt: string, spanIO: string): Promise<Verdict> {
    let resp: Response;
    try {
      resp = await this.fetchImpl(
        `${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.config.apiKey
              ? { authorization: `Bearer ${this.config.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model: this.config.model,
            temperature: 0,
            messages: [
              { role: "system", content: prompt },
              { role: "user", content: boundSpanIO(spanIO) },
            ],
          }),
        },
      );
    } catch (err) {
      throw new JudgeError(`judge request failed: ${String(err)}`);
    }
    if (!resp.ok) {
      throw new JudgeError(`judge endpoint returned ${resp.status}`);
    }
    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      throw new JudgeError("judge response was not JSON");
    }
    const content = (body as { choices?: { message?: { content?: unknown } }[] })
      ?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new JudgeError("judge response missing choices[0].message.content");
    }
    return parseJudgeVerdict(content);
  }
}
