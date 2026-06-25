import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  addDatasetItem,
  createDataset,
  getDataset,
  getDatasets,
} from "../api/client.js";

/** Don't retry deterministic 4xx; retry transient errors up to twice. */
function retry(failureCount: number, err: unknown): boolean {
  if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
    return false;
  }
  return failureCount < 2;
}

/**
 * The datasets list + create/add mutations (M26d). Mutations invalidate the list so
 * item counts stay fresh (mirrors useTags/useAnnotations). Keyed by ["datasets"].
 */
export function useDatasets() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["datasets"], queryFn: getDatasets, retry });

  const create = useMutation({
    mutationFn: (name: string) => createDataset(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["datasets"] }),
  });

  const addItem = useMutation({
    mutationFn: (v: { datasetId: string; traceId: string }) =>
      addDatasetItem(v.datasetId, v.traceId),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ["datasets"] });
      void qc.invalidateQueries({ queryKey: ["dataset", v.datasetId] });
    },
  });

  return { query, create, addItem };
}

/** One dataset's detail (items), keyed by id (M26d). */
export function useDataset(datasetId: string) {
  return useQuery({
    queryKey: ["dataset", datasetId],
    queryFn: () => getDataset(datasetId),
    enabled: datasetId.length > 0,
    retry,
  });
}
