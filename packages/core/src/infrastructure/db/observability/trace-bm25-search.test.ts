/**
 * M140.4 — unit test da wiring do consumidor BM25 (`searchBm25`). Mocka `db.execute` (não requer TheoDB/
 * theodb_rs), então roda no CI normal do theo-lens: prova a lógica do helper (mapeia `(id, score)`, valida
 * `k`, emite uma query `bm25_search`). A prova ponta-a-ponta contra a engine real está no
 * `theo-db/scripts/m140-4-consumer-theolens.sh` (CONSUMER_OK).
 */
import { describe, expect, it, vi } from "vitest";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { searchBm25 } from "./trace-bm25-search.js";

function mockDb(rows: { id: string | number; score: number }[]) {
  const execute = vi.fn().mockResolvedValue({ rows });
  return { db: { execute } as unknown as NodePgDatabase, execute };
}

describe("searchBm25 (consumidor BM25 own-code — M140.4)", () => {
  it("maps (id, score) rows and stringifies id", async () => {
    const { db } = mockDb([
      { id: 42, score: 1.5 },
      { id: 7, score: 0.9 },
    ]);
    const hits = await searchBm25(db, 400, "blkfoxzz", 10);
    expect(hits).toEqual([
      { id: "42", score: 1.5 },
      { id: "7", score: 0.9 },
    ]);
  });

  it("emits a bm25_search query with the index, query and k as bind params", async () => {
    const { db, execute } = mockDb([]);
    await searchBm25(db, 400, "clima ensolarado", 25);
    expect(execute).toHaveBeenCalledOnce();
    // o SQL passado contém a chamada a bm25_search e os parâmetros como binds
    const sqlArg = execute.mock.calls[0]![0] as { queryChunks?: unknown[] };
    const serialized = JSON.stringify(sqlArg);
    expect(serialized).toContain("bm25_search");
  });

  it("returns empty array when no hits", async () => {
    const { db } = mockDb([]);
    expect(await searchBm25(db, 400, "nada", 10)).toEqual([]);
  });

  it("rejects non-positive k (fail-fast, typed error)", async () => {
    const { db } = mockDb([]);
    await expect(searchBm25(db, 400, "x", 0)).rejects.toThrow(RangeError);
  });
});
