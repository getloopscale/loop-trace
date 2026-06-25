import { useState } from "react";
import { ThumbsUp, ThumbsDown, X } from "lucide-react";
import { useAnnotations } from "../hooks/useAnnotations.js";
import { Loading, ErrorState, EmptyState } from "./states.js";

const FEEDBACK = "feedback";

/**
 * Writable Annotations panel (M26b): the human's 👍/👎 + free-text note on a trace
 * (`spanId` omitted) or a span. Lists existing annotations for the scope (newest-first
 * from the server), and writes a new one (upsert — latest wins) or clears it. Mirrors
 * `TraceTags` (chips + form) but typed feedback. Loading/error/empty states.
 */
export function AnnotationsPanel({
  traceId,
  spanId,
}: {
  traceId: string;
  spanId?: string;
}) {
  const { query, add, remove } = useAnnotations(traceId);
  const [label, setLabel] = useState<"thumbs_up" | "thumbs_down" | null>(null);
  const [note, setNote] = useState("");

  // The server returns every annotation for the trace; this panel shows only the
  // ones for the current scope (a span, or trace-level when spanId is undefined).
  const scoped = (query.data?.annotations ?? []).filter(
    (a) => (a.spanId ?? undefined) === spanId,
  );

  const canSubmit = label != null || note.trim().length > 0;

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    add.mutate(
      {
        ...(spanId !== undefined ? { spanId } : {}),
        name: FEEDBACK,
        ...(label != null ? { label } : {}),
        ...(note.trim().length > 0 ? { note: note.trim() } : {}),
      },
      {
        onSuccess: () => {
          setLabel(null);
          setNote("");
        },
      },
    );
  };

  const thumbBtn = (
    value: "thumbs_up" | "thumbs_down",
    Icon: typeof ThumbsUp,
    aria: string,
  ) => (
    <button
      type="button"
      aria-label={aria}
      aria-pressed={label === value}
      onClick={() => setLabel((cur) => (cur === value ? null : value))}
      className={`inline-flex items-center rounded-md border px-2 py-1 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring ${
        label === value
          ? "border-ring bg-muted text-foreground"
          : "border-border text-muted-foreground hover:text-foreground"
      }`}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );

  return (
    <section aria-label="annotations" className="flex flex-col gap-3">
      {query.isLoading ? (
        <Loading label="Loading annotations…" rows={1} />
      ) : query.isError ? (
        <ErrorState message="Failed to load annotations" />
      ) : scoped.length === 0 ? (
        <EmptyState message="No annotations yet" />
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {scoped.map((a) => (
            <li
              key={`${a.spanId ?? ""}-${a.name}-${a.annotatorKind}`}
              className="flex items-start justify-between gap-2 rounded-md border border-border bg-card p-3"
            >
              <div className="flex flex-col gap-1">
                <span className="flex items-center gap-2 text-body-sm">
                  {a.label === "thumbs_up" ? (
                    <ThumbsUp className="size-4 text-muted-foreground" aria-label="thumbs up" />
                  ) : a.label === "thumbs_down" ? (
                    <ThumbsDown className="size-4 text-muted-foreground" aria-label="thumbs down" />
                  ) : a.label != null ? (
                    <span className="rounded-full border border-border px-2 py-0.5">{a.label}</span>
                  ) : null}
                  <span className="text-xs text-muted-foreground">{a.annotatorKind}</span>
                </span>
                {a.note != null ? <p className="text-body-sm">{a.note}</p> : null}
              </div>
              <button
                type="button"
                aria-label="clear annotation"
                className="leading-none text-muted-foreground transition-colors hover:text-foreground"
                onClick={() =>
                  remove.mutate(
                    a.spanId !== undefined
                      ? { spanId: a.spanId, name: a.name }
                      : { name: a.name },
                  )
                }
              >
                <X className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={onSubmit} className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          {thumbBtn("thumbs_up", ThumbsUp, "give thumbs up")}
          {thumbBtn("thumbs_down", ThumbsDown, "give thumbs down")}
        </div>
        <textarea
          aria-label="annotation note"
          placeholder="add a note (optional)"
          value={note}
          maxLength={2000}
          rows={2}
          onChange={(e) => setNote(e.target.value)}
          className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        />
        <button
          type="submit"
          disabled={!canSubmit}
          className="self-start rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
        >
          Save feedback
        </button>
      </form>
    </section>
  );
}
