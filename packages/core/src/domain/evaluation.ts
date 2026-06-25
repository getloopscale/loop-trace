/**
 * Online evaluations (M26 read-path). An evaluator's result attached to a span as
 * OpenInference-style attributes: `eval.<name>.score` (number), `eval.<name>.label`
 * (string), `eval.<name>.explanation` (string). `<name>` is the evaluator (e.g.
 * `hallucination`). An eval counts when it has at least a score OR a label —
 * explanation alone is not a scored evaluation (ADR D1).
 *
 * `extractEvaluations` is PURE + TOTAL: it never throws. A non-number score, an
 * empty/missing evaluator name, or a non-`eval.` key is ignored — so a malformed
 * attribute never crashes ingest (mirrors the M24 `websearch_to_tsquery` totality).
 */
export interface SpanEvaluation {
  name: string;
  score?: number;
  label?: string;
  explanation?: string;
}

/** Per-evaluator aggregate across a window of spans (the Online Evaluators card). */
export interface EvaluatorSummary {
  name: string;
  count: number;
  /** Mean of the non-null numeric scores (undefined when none had a score). */
  avgScore?: number;
  /** Label → occurrence count. */
  labels: Record<string, number>;
}

// `eval.<name>.<field>` — name is a non-empty run of non-dot chars; field is whitelisted.
const EVAL_KEY_RE = /^eval\.([^.]+)\.(score|label|explanation)$/;

interface Draft {
  score?: number;
  label?: string;
  explanation?: string;
  keys: string[];
}

/**
 * Extract eval results from a span's flattened attributes. Returns the counted
 * evaluations + the attribute keys that should be stripped from the persisted bag
 * (only the keys of counted evals — explanation-only groups are left untouched).
 */
export function extractEvaluations(
  attributes: Record<string, unknown> | undefined,
): { evaluations: SpanEvaluation[]; strippedKeys: string[] } {
  if (attributes == null) return { evaluations: [], strippedKeys: [] };

  const drafts = new Map<string, Draft>();
  for (const [key, value] of Object.entries(attributes)) {
    const m = EVAL_KEY_RE.exec(key);
    if (m == null) continue;
    const name = m[1]!;
    const field = m[2]!;
    const draft = drafts.get(name) ?? { keys: [] };
    if (field === "score" && typeof value === "number" && Number.isFinite(value)) {
      draft.score = value;
      draft.keys.push(key);
    } else if (field === "label" && typeof value === "string") {
      draft.label = value;
      draft.keys.push(key);
    } else if (field === "explanation" && typeof value === "string") {
      draft.explanation = value;
      draft.keys.push(key);
    }
    drafts.set(name, draft);
  }

  const evaluations: SpanEvaluation[] = [];
  const strippedKeys: string[] = [];
  for (const [name, draft] of drafts) {
    // An eval needs a score or a label (explanation alone does not count, D1).
    if (draft.score === undefined && draft.label === undefined) continue;
    const evaluation: SpanEvaluation = { name };
    if (draft.score !== undefined) evaluation.score = draft.score;
    if (draft.label !== undefined) evaluation.label = draft.label;
    if (draft.explanation !== undefined) evaluation.explanation = draft.explanation;
    evaluations.push(evaluation);
    strippedKeys.push(...draft.keys);
  }
  return { evaluations, strippedKeys };
}
