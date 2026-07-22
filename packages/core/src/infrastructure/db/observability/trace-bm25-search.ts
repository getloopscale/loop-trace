/**
 * M140.4 — primeiro consumidor da engine BM25 own-code do TheoDB (`theo-db`).
 *
 * Retorna os `id`s de documentos lexicais relevantes para `query` via `bm25_search` (own-code, Tantivy MIT) —
 * a alternativa à relevância `ts_rank` atual da busca de traces (`trace-read-repository.ts` `listTraces`, o
 * ordena por `ts_rank(search_tsv, websearch_to_tsquery(...))`). O TheoDB mediu (M140.1) que a BM25 own-engine
 * bate o `ts_rank` no retrieval lexical puro — o caso desta busca.
 *
 * **ADITIVO e feature-flagged por infraestrutura:** só é utilizável quando o banco é TheoDB (extensão
 * `theodb_rs`) com um índice BM25 construído via `bm25_build(index_id, spans_lex, id, body)` sobre o corpus
 * dos spans (`body = input_value || output_value`, id estável a partir do trace). O `ts_rank` default do
 * `listTraces` fica **intocado**. O CUTOVER de produção (manutenção do índice + os 30 dias de dogfood) é o
 * **M141**; este módulo é a wiring do consumidor, provada ponta-a-ponta pelo
 * `theo-db/scripts/m140-4-consumer-theolens.sh` (veredito CONSUMER_OK).
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export interface Bm25Hit {
  id: string;
  score: number;
}

/**
 * Executa a busca BM25 own-code sobre o índice lexical `indexId`, retornando `(id, score)` ordenado por
 * relevância decrescente, top-`k`. `query` é bind param (sem injeção — o `bm25_search` sanitiza o texto livre
 * no lado do TheoDB, como o `websearch_to_tsquery` faz para o `ts_rank`). O caller junta os `id`s de volta ao
 * `trace_id` (a tabela lexical mantém `id -> trace_id`).
 */
export async function searchBm25(
  db: NodePgDatabase,
  indexId: number,
  query: string,
  k = 50,
): Promise<Bm25Hit[]> {
  if (k <= 0) throw new RangeError(`searchBm25: k must be > 0 (got ${k})`);
  const res = await db.execute(
    sql`SELECT id, score FROM bm25_search(${indexId}, ${query}, ${k}) ORDER BY score DESC`,
  );
  const rows = (res as unknown as { rows: { id: string | number; score: number }[] }).rows;
  return rows.map((r) => ({ id: String(r.id), score: Number(r.score) }));
}
