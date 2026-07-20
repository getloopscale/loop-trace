/**
 * M131 B2 — Session Coherence evaluator (Arize-parity). The "session-level runner" the M36 engine
 * lacks: it assembles the N ordered traces of a session into a compact transcript and asks the
 * REUSED `JudgeClient` (M36 transport — retry + circuit breaker + strict verdict parse) to judge
 * cross-turn COHERENCE, then maps the generic `Verdict` to a session verdict. Pure + injectable
 * (DIP) so unit tests drive it with a fake judge; the LIVE path passes `OpenAICompatibleJudge`.
 */
import type { Verdict } from "./evaluator.js";
import type { JudgeClient } from "./llm-judge.js";
import type { TraceListItem } from "../observability/trace-list.js";

/** The persisted evaluator name (mirrors span_evaluations `name`). */
export const SESSION_COHERENCE_NAME = "session_coherence";

/** verdict = coherent when the coherence score ≥ this (≥3 of 4 sub-signals in the rubric). */
export const COHERENCE_THRESHOLD = 0.75;

const MAX_TURNS = 20; // bound the prompt (cost/latency) — first (MAX-5) + last 5 when longer.
const PREVIEW_CAP = 200; // per-field truncation.

export interface SessionCoherenceVerdict {
  verdict: "coherent" | "incoherent";
  /** 0..1 coherence (fraction of rubric sub-signals passed). */
  score: number;
  /** the judge's 1-3 sentence rationale, citing the turn where coherence broke (if any). */
  reasoning?: string;
}

/**
 * The rubric. Judges ONLY cross-turn coherence (topic adherence · context retention ·
 * non-contradiction · goal progression), NOT answer quality. Strict JSON so the reused
 * `parseJudgeVerdict` validates it (score ∈ [0,1], fail-closed).
 */
export const SESSION_COHERENCE_PROMPT = [
  "You are an evaluator of multi-turn AI-agent sessions.",
  "Judge ONLY cross-turn COHERENCE, never answer quality. Four sub-signals:",
  "1) topic adherence — later turns stay on / build the thread's task;",
  "2) context retention — the assistant reuses facts/decisions established earlier;",
  "3) non-contradiction — no self-contradiction across turns;",
  "4) goal progression — the thread moves toward resolving the user's goal.",
  'Output STRICT JSON only: {"score": <0..1 = fraction of sub-signals satisfied>, "label": "coherent"|"incoherent", "explanation": "<1-3 sentences; cite the turn index where coherence broke, if any>"}.',
  "Be conservative: only mark incoherent with a concrete turn-index citation. score ≥ 0.75 ⇒ coherent.",
].join("\n");

function truncate(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** Numeric-safe ascending compare of unix-nano strings (longer = larger; then lexicographic). */
function byStartAsc(a: TraceListItem, b: TraceListItem): number {
  const as = a.startTimeUnixNano ?? "0";
  const bs = b.startTimeUnixNano ?? "0";
  if (as.length !== bs.length) return as.length - bs.length;
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/**
 * Assemble the ordered session transcript (one line per turn: user + assistant previews).
 * Turns are ordered by span start-time; a long session keeps the first (MAX-5) + last 5 turns
 * with an omission marker so the arc (start + resolution) survives within budget.
 */
export function assembleSessionTranscript(traces: TraceListItem[]): string {
  const ordered = [...traces].sort(byStartAsc);
  let shown = ordered;
  let omitted = 0;
  if (ordered.length > MAX_TURNS) {
    shown = [...ordered.slice(0, MAX_TURNS - 5), ...ordered.slice(-5)];
    omitted = ordered.length - shown.length;
  }
  const lines = shown.map((t, i) => {
    const user = truncate(t.inputPreview, PREVIEW_CAP);
    const asst = truncate(t.outputPreview, PREVIEW_CAP);
    return `Turn ${i}: user=${JSON.stringify(user)} assistant=${JSON.stringify(asst)}`;
  });
  if (omitted > 0) lines.splice(MAX_TURNS - 5, 0, `…(${omitted} turns omitted)…`);
  return lines.join("\n");
}

/** Map the reused generic Verdict → a session coherence verdict (prefer score; fall back to label). */
export function shapeCoherenceVerdict(v: Verdict): SessionCoherenceVerdict {
  let score: number;
  if (typeof v.score === "number") score = v.score;
  else if (v.label === "coherent") score = 1;
  else score = 0; // "incoherent" or label-less → fail-closed to incoherent (parseJudgeVerdict guarantees score|label)
  const verdict = score >= COHERENCE_THRESHOLD ? "coherent" : "incoherent";
  const out: SessionCoherenceVerdict = { verdict, score };
  if (v.explanation != null && v.explanation.trim() !== "") out.reasoning = v.explanation;
  return out;
}

/**
 * Evaluate a session's coherence over its N ordered member traces via the injected judge.
 * Throws `JudgeError` (fail-closed) when the judge fails — the caller writes NO verdict.
 */
export async function evaluateSessionCoherence(
  judge: JudgeClient,
  traces: TraceListItem[],
): Promise<SessionCoherenceVerdict> {
  const transcript = assembleSessionTranscript(traces);
  const v = await judge.judge(SESSION_COHERENCE_PROMPT, transcript);
  return shapeCoherenceVerdict(v);
}
