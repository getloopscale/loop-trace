/**
 * M33 — "Ask about this step" copilot domain. Pure: assembles a BOUNDED chat prompt
 * grounding an LLM answer in a selected span (or the trace) + the operator's question.
 * The HTTP call is the shared {@link ChatClient} (chat.ts); persistence is none (D4).
 */
import type { ChatMessage } from "./chat.js";
import { deriveKind } from "./evaluator.js";
import type { TraceTreeNode } from "./span-repository.js";

/** Typed error for copilot request problems (surfaced as 4xx/5xx by the handler). */
export class CopilotError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "CopilotError";
  }
}

const MAX_FIELD_BYTES = 8 * 1024; // per-field prompt bound (reuse the M36 budget)
const MAX_CHILDREN = 20; // cap the children summary
const MAX_QUESTION_BYTES = 4 * 1024; // EC-1 request bound
/** Cap the answer returned to the client so a runaway model can't flood it (EC-6). */
export const MAX_ANSWER_BYTES = 32 * 1024;

function bound(s: string, max = MAX_FIELD_BYTES): string {
  const buf = Buffer.from(s, "utf8");
  return buf.byteLength <= max ? s : buf.subarray(0, max).toString("utf8");
}

/** Cap an answer to {@link MAX_ANSWER_BYTES} (EC-6). */
export function capAnswer(answer: string): string {
  return bound(answer, MAX_ANSWER_BYTES);
}

/** Validate the user's question (EC-1): non-empty trimmed, ≤ 4 KiB. Throws CopilotError. */
export function validateQuestion(question: unknown): string {
  if (typeof question !== "string" || question.trim() === "") {
    throw new CopilotError("question must be a non-empty string", "INVALID_QUESTION");
  }
  if (Buffer.byteLength(question, "utf8") > MAX_QUESTION_BYTES) {
    throw new CopilotError("question exceeds 4 KiB", "INVALID_QUESTION");
  }
  return question.trim();
}

/** Flatten a trace tree into [node, hasChildren] pairs (pre-order). */
function flatten(node: TraceTreeNode, out: { node: TraceTreeNode; hasChildren: boolean }[]): void {
  out.push({ node, hasChildren: node.children.length > 0 });
  for (const c of node.children) flatten(c, out);
}

function spanLine(node: TraceTreeNode, hasChildren: boolean): string {
  const kind = deriveKind(node, hasChildren);
  const parts = [`name=${node.name}`, `kind=${kind}`];
  if (node.model != null) parts.push(`model=${node.model}`);
  if (node.statusCode != null) parts.push(`status=${node.statusCode}`);
  return parts.join(" ");
}

/**
 * Build the chat messages for an "ask about this step" request. When `spanId` is
 * given it grounds the answer in that span's detail (+ a short children summary);
 * otherwise it summarizes the trace (root + notable spans). All fields are byte-bounded.
 * Assumes `spanId` (when given) exists in the tree — the handler 404s otherwise (EC-2).
 */
export function buildCopilotPrompt(
  tree: TraceTreeNode,
  spanId: string | undefined,
  question: string,
): ChatMessage[] {
  const all: { node: TraceTreeNode; hasChildren: boolean }[] = [];
  flatten(tree, all);
  const system =
    "You are a trace-debugging copilot for an AI-agent observability tool. Answer the " +
    "user's question about the given span/trace concisely and ground every claim in the " +
    "provided context. If the context is insufficient, say so — do not invent details.";

  let context: string;
  if (spanId != null) {
    const found = all.find((e) => e.node.spanId === spanId);
    // EC-2: a spanId not in the trace is a client error, NOT a silent trace-mode
    // fallback — surface it so the handler returns 404 SPAN_NOT_FOUND.
    if (found === undefined) {
      throw new CopilotError(`span ${spanId} not in trace`, "SPAN_NOT_FOUND");
    }
    const e = found;
    const io = [
      e.node.inputValue != null ? `input: ${bound(e.node.inputValue)}` : "",
      e.node.outputValue != null ? `output: ${bound(e.node.outputValue)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const children = e.node.children
      .slice(0, MAX_CHILDREN)
      .map((c) => `  - ${spanLine(c, c.children.length > 0)}`)
      .join("\n");
    context =
      `SPAN: ${spanLine(e.node, e.hasChildren)}\n` +
      (io ? `${io}\n` : "") +
      (children ? `children:\n${children}\n` : "");
  } else {
    const summary = all
      .slice(0, MAX_CHILDREN)
      .map((e) => `- ${spanLine(e.node, e.hasChildren)}`)
      .join("\n");
    context = `TRACE ${tree.traceId} spans:\n${summary}\n`;
  }

  return [
    { role: "system", content: system },
    { role: "user", content: `Context:\n${bound(context)}\n\nQuestion: ${question}` },
  ];
}
