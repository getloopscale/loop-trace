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
    <section aria-label="tags" className="trace-tags">
      <h3>Tags</h3>
      {query.isLoading ? (
        <Loading label="Loading tags…" />
      ) : query.isError || !query.data ? (
        <ErrorState message="Failed to load tags" />
      ) : (
        <ul className="tag-chips">
          {query.data.tags.length === 0 ? (
            <li className="tag-empty">No tags yet</li>
          ) : (
            query.data.tags.map((tag) => (
              <li key={tag} className="tag-chip">
                <span>{tag}</span>
                <button
                  type="button"
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
      <form onSubmit={onAdd} className="tag-add">
        <input
          type="text"
          aria-label="add tag"
          placeholder="add a tag"
          value={input}
          maxLength={64}
          onChange={(e) => setInput(e.target.value)}
        />
        <button type="submit">Add</button>
      </form>
    </section>
  );
}
