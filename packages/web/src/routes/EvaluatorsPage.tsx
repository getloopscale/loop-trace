import { useState } from "react";
import { DataTable, type DataTableColumn } from "@usetheo/ui";

import { useEvaluatorDefs } from "../hooks/useEvaluatorDefs.js";
import { Loading, ErrorState, EmptyState } from "../components/primitives/States.js";
import type { EvaluatorRecordDTO } from "../api/types.js";

/**
 * M36 — Evaluators management (API-first, minimal UI per grill Q6). List the
 * workspace's evaluators with a create form (rule predicate OR llm_judge prompt),
 * a per-row Run button, and a guard form. Per-span verdicts + breaches are surfaced
 * by the existing M26 read surfaces (Evals & Metrics, trace Evaluations tab).
 */
export function EvaluatorsPage() {
  const { query, create, run, remove, addGuard } = useEvaluatorDefs();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"rule" | "llm_judge">("rule");
  const [predicate, setPredicate] = useState("status:error");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("gpt-4o");
  const [target, setTarget] = useState("");

  const onCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (n.length === 0) return;
    const body =
      kind === "rule"
        ? { name: n, kind, config: { predicate }, target }
        : { name: n, kind, config: { prompt, model }, target };
    create.mutate(body, { onSuccess: () => setName("") });
  };

  const columns: DataTableColumn<EvaluatorRecordDTO>[] = [
    { key: "name", label: "Name", render: (e) => e.name },
    { key: "kind", label: "Kind", render: (e) => e.kind },
    { key: "target", label: "Target", render: (e) => e.target || "(root)" },
    {
      key: "actions",
      label: "Actions",
      render: (e) => (
        <div className="flex gap-2">
          <button
            type="button"
            className="text-primary"
            onClick={() => run.mutate(e.id)}
            disabled={run.isPending}
          >
            Run
          </button>
          <button
            type="button"
            className="text-danger"
            onClick={() => remove.mutate(e.id)}
            disabled={remove.isPending}
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() =>
              addGuard.mutate({ evaluatorId: e.id, operator: "lt", threshold: 0.5 })
            }
            disabled={addGuard.isPending}
          >
            + Guard &lt;0.5
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="evaluators-page flex flex-col gap-4">
      <h1 className="text-display-md font-display">Evaluators</h1>

      <form onSubmit={onCreate} className="flex flex-wrap gap-2 items-end">
        <input
          aria-label="Evaluator name"
          placeholder="name (a-z0-9_-)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <select aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value as "rule" | "llm_judge")}>
          <option value="rule">rule</option>
          <option value="llm_judge">llm_judge</option>
        </select>
        {kind === "rule" ? (
          <input
            aria-label="Predicate"
            placeholder="span-query (e.g. status:error)"
            value={predicate}
            onChange={(e) => setPredicate(e.target.value)}
          />
        ) : (
          <>
            <input
              aria-label="Judge prompt"
              placeholder="judge prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <input
              aria-label="Judge model"
              placeholder="model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
          </>
        )}
        <input
          aria-label="Target span-query"
          placeholder="target (blank = root)"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
        />
        <button type="submit" disabled={create.isPending}>
          Create
        </button>
      </form>
      {create.isError ? <ErrorState message="Create failed (check name / predicate)." /> : null}

      {query.isLoading ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState message="Failed to load evaluators." />
      ) : (query.data?.evaluators.length ?? 0) === 0 ? (
        <EmptyState message="No evaluators yet — create one above." />
      ) : (
        <DataTable data={query.data!.evaluators} columns={columns} rowKey={(e) => e.id} />
      )}
    </div>
  );
}
