import { useState } from "react";
import { useTraceTags } from "../hooks/useTags.js";
import { Loading, ErrorState } from "./states.js";

/**
 * Tags on a trace (M14): current tags as removable chips + an add input. Tags are
 * free-form, applied here in the UI (no SDK change). Add/remove write through to
 * the API and the chip list reflects the server response. Loading/error states.
 */
export function TraceTags({ traceId }: { traceId: string }) {
  const { query, add, remove } = useTraceTags(traceId);
  const [input, setInput] = useState("");

  const onAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const tag = input.trim();
    if (tag.length === 0) return;
    add.mutate(tag, { onSuccess: () => setInput("") });
  };

  return (
    <section aria-label="tags" className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Tags
      </h3>
      {query.isLoading ? (
        <Loading label="Loading tags…" rows={1} />
      ) : query.isError || !query.data ? (
        <ErrorState message="Failed to load tags" />
      ) : (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {query.data.tags.length === 0 ? (
            <li className="text-xs italic text-muted-foreground">No tags yet</li>
          ) : (
            query.data.tags.map((tag) => (
              <li
                key={tag}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-foreground"
              >
                <span>{tag}</span>
                <button
                  type="button"
                  className="leading-none text-muted-foreground transition-colors hover:text-foreground"
                  aria-label={`remove tag ${tag}`}
                  onClick={() => remove.mutate(tag)}
                >
                  ×
                </button>
              </li>
            ))
          )}
        </ul>
      )}
      <form onSubmit={onAdd} className="flex gap-2">
        <input
          type="text"
          aria-label="add tag"
          placeholder="add a tag"
          value={input}
          maxLength={64}
          onChange={(e) => setInput(e.target.value)}
          className="flex-1 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        />
        <button
          type="submit"
          className="rounded-md border border-border bg-background px-3 py-1 text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        >
          Add
        </button>
      </form>
    </section>
  );
}
