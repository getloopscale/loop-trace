import { useState } from "react";
import { Sparkles } from "lucide-react";
import { useCopilot } from "../hooks/useCopilot.js";
import { ApiError } from "../api/client.js";
import { MarkdownText } from "../components/MarkdownText.js";

/** Map a copilot ApiError to an operator-facing message (fail-closed states, D2). */
function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 400:
        return "Please enter a question (max 4 KB).";
      case 403:
        return "You don't have permission to use the copilot.";
      case 404:
        return "Trace or span not found.";
      case 429:
        return "Rate limit reached — try again in a minute.";
      case 502:
        return "Copilot is temporarily unavailable. Try again shortly.";
      case 503:
        return "Copilot is not configured on this deployment.";
      default:
        return "Something went wrong asking the copilot.";
    }
  }
  return "Something went wrong asking the copilot.";
}

/**
 * "Ask about this step" copilot panel (M33). A question box + a grounded, XSS-safe
 * markdown answer, scoped to the currently-selected span (or the whole trace when
 * none). Stateless (D4): each ask is one mutation; disabled/unavailable/rate-limited
 * surface as an inline alert (fail-closed — never a fabricated answer).
 */
export function AskPanel({
  traceId,
  spanId,
}: {
  traceId: string;
  // `| undefined` is required under exactOptionalPropertyTypes so callers may pass a
  // possibly-undefined selected span (TracePage's `active?.spanId`) directly.
  spanId?: string | undefined;
}) {
  const [question, setQuestion] = useState("");
  const ask = useCopilot(traceId);
  const trimmed = question.trim();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (trimmed.length === 0) return;
    ask.mutate({ question: trimmed, ...(spanId != null ? { spanId } : {}) });
  };

  return (
    <section aria-label="Ask about this step" className="mt-4 rounded-md border border-border p-4">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
        <Sparkles className="size-4 text-primary" aria-hidden />
        Ask about this {spanId != null ? "step" : "trace"}
      </h2>
      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <textarea
          aria-label="question"
          placeholder="e.g. Why did this step fail?"
          value={question}
          maxLength={4096}
          rows={2}
          onChange={(e) => setQuestion(e.target.value)}
          className="w-full resize-y rounded border border-border bg-background px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        />
        <button
          type="submit"
          disabled={trimmed.length === 0 || ask.isPending}
          className="self-start rounded border border-border px-3 py-1 text-sm text-foreground transition-colors hover:bg-muted disabled:opacity-50"
        >
          {ask.isPending ? "Asking…" : "Ask"}
        </button>
      </form>

      {ask.isError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {errorMessage(ask.error)}
        </p>
      ) : null}

      {ask.data ? (
        <div className="mt-3 rounded border border-border bg-muted/30 p-3" aria-label="copilot answer">
          <MarkdownText text={ask.data.answer} />
        </div>
      ) : null}
    </section>
  );
}
