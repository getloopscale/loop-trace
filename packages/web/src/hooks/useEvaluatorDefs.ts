import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  ApiError,
  getEvaluatorDefs,
  createEvaluatorDef,
  runEvaluatorDef,
  deleteEvaluatorDef,
  createMonitorDef,
} from "../api/client.js";
import type { NewEvaluatorDTO, NewGuardDTO } from "../api/types.js";

function retry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
  return failureCount < 2;
}

/** M36: the evaluators list + create/run/delete/guard mutations. Keyed ["evaluator-defs"]. */
export function useEvaluatorDefs() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["evaluator-defs"], queryFn: getEvaluatorDefs, retry });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["evaluator-defs"] });

  const create = useMutation({
    mutationFn: (body: NewEvaluatorDTO) => createEvaluatorDef(body),
    onSuccess: invalidate,
  });
  const run = useMutation({
    mutationFn: (id: string) => runEvaluatorDef(id),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteEvaluatorDef(id),
    onSuccess: invalidate,
  });
  const addGuard = useMutation({
    mutationFn: (body: NewGuardDTO) => createMonitorDef(body),
    onSuccess: invalidate,
  });

  return { query, create, run, remove, addGuard };
}
