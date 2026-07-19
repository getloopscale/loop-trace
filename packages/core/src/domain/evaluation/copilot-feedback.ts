/**
 * M83 — copilot answer feedback domain. A thumbs up/down on ONE Ask-copilot answer, keyed by the
 * client-side `turnId` (the M33 ask is stateless/single-turn, so there is no server answer id — the
 * thread's turn ordinal is the stable key, documented granularity, ADR risk-1). A re-vote UPSERTs
 * the label (up↔down toggle); it never duplicates.
 */

export type FeedbackLabel = "up" | "down";

/** The input a caller supplies to record feedback (workspace comes from the Principal, never here). */
export interface AskFeedbackInput {
  turnId: string;
  label: FeedbackLabel;
  spanId?: string;
  question?: string;
}

/** The persisted feedback record. */
export interface CopilotFeedbackRecord {
  id: string;
  traceId: string;
  turnId: string;
  spanId?: string;
  label: FeedbackLabel;
  question?: string;
  updatedAt: string;
}

/** Typed validation error at the write boundary (Rule 8 — fail-clear, not a raw 500). */
export class InvalidFeedbackError extends Error {
  readonly code = "INVALID_FEEDBACK";
  constructor(message: string) {
    super(message);
    this.name = "InvalidFeedbackError";
  }
}

const TURN_ID_MAX = 128;

/**
 * Validate + normalize a raw feedback body at the boundary. Throws InvalidFeedbackError (→ 400) on a
 * missing/blank turnId or a label outside {up,down}. `spanId`/`question` are optional; a blank string
 * is dropped. Never trusts the caller for the workspace (resolved from the Principal upstream).
 */
export function normalizeAskFeedback(raw: unknown): AskFeedbackInput {
  if (typeof raw !== "object" || raw === null) {
    throw new InvalidFeedbackError("feedback body must be an object");
  }
  const body = raw as Record<string, unknown>;
  const turnId = typeof body["turnId"] === "string" ? body["turnId"].trim() : "";
  if (turnId.length === 0 || turnId.length > TURN_ID_MAX) {
    throw new InvalidFeedbackError(`turnId is required (1-${TURN_ID_MAX} chars)`);
  }
  const label = body["label"];
  if (label !== "up" && label !== "down") {
    throw new InvalidFeedbackError("label must be 'up' or 'down'");
  }
  const spanId = typeof body["spanId"] === "string" && body["spanId"].trim().length > 0 ? body["spanId"].trim() : undefined;
  const question = typeof body["question"] === "string" && body["question"].trim().length > 0 ? body["question"].slice(0, 2000) : undefined;
  return {
    turnId,
    label,
    ...(spanId !== undefined ? { spanId } : {}),
    ...(question !== undefined ? { question } : {}),
  };
}
