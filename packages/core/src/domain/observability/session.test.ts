import { describe, it, expect } from "vitest";
import { shapeSessionDetail, type RawSessionDetail } from "./session.js";

const base: RawSessionDetail = {
  sessionId: "s1",
  firstSeenAt: new Date("2026-06-22T00:00:00Z"),
  lastSeenAt: new Date("2026-06-22T01:00:00Z"),
  traceCount: 4,
  costUsd: 0.012345,
  totalTokens: 1500,
  errorCount: 1,
  p50: 10.1234,
  p95: 88.5678,
  traces: [],
};

describe("shapeSessionDetail (M13)", () => {
  it("test_shape_session_detail_sums_and_rounds", () => {
    const out = shapeSessionDetail(base);
    // MUDADO no #121, e a mudança é o ponto: este número era `0.012` e ancorava o
    // arredondamento a 3 casas — ou seja, o teste guardava o defeito em vez do
    // comportamento. Custo agora vai a 6 casas (`roundUsd`), como em `pricing.ts`.
    // Latência e taxa seguem em 3, que é onde 3 casas fazem sentido.
    expect(out.costUsd).toBe(0.012345);
    expect(out.latencyP50Ms).toBe(10.123);
    expect(out.latencyP95Ms).toBe(88.568);
    expect(out.totalTokens).toBe(1500);
    expect(out.firstSeenAt).toBe("2026-06-22T00:00:00.000Z");
  });

  it("test_shape_session_detail_preserves_subcent_cost", () => {
    // Regressão LT-063 / #121. `round3` zerava TODO custo abaixo de $0.0005 — e essa é a
    // faixa comum de uma chamada de agente com modelo barato, não um caso de canto. O
    // sintoma era a resposta se contradizer sozinha: `costUsd: 0` no topo e
    // `traces[].costUsd: 0.000192` duas vezes no mesmo JSON.
    //
    // O piso de precisão não é escolha nova: `pricing.ts` já calcula custo com 6 casas
    // (`Math.round(total * 1e6) / 1e6`). Um agregado mais grosseiro que as parcelas que
    // ele soma não pode fechar por construção.
    const out = shapeSessionDetail({ ...base, costUsd: 0.000384 });
    expect(out.costUsd).toBe(0.000384);
  });

  it("test_shape_session_detail_cost_equals_sum_of_member_traces", () => {
    // O invariante que o usuário enxerga: o total da sessão bate com a soma do que ela lista.
    // Sem isto, o teste acima passaria com qualquer precisão ≥ 6 casas sem provar coerência.
    const parcelas = [0.000192, 0.000192];
    const out = shapeSessionDetail({ ...base, costUsd: parcelas[0]! + parcelas[1]! });
    expect(out.costUsd).toBe(0.000384);
  });

  it("test_shape_session_error_rate_zero_guard", () => {
    const out = shapeSessionDetail({ ...base, traceCount: 0, errorCount: 0 });
    expect(out.errorRate).toBe(0); // no NaN on zero traceCount
  });

  it("test_shape_session_detail_error_rate_rounded", () => {
    const out = shapeSessionDetail({ ...base, traceCount: 3, errorCount: 1 });
    expect(out.errorRate).toBe(0.333); // 1/3 round3-ed
  });

  it("test_shape_session_null_aggregates_coalesce_to_zero", () => {
    // EC-1: an all-tokenless session has NULL SUM/percentile → 0, not NaN/reject.
    const out = shapeSessionDetail({
      ...base,
      costUsd: null,
      totalTokens: null,
      p50: null,
      p95: null,
    });
    expect(out.costUsd).toBe(0);
    expect(out.totalTokens).toBe(0);
    expect(out.latencyP50Ms).toBe(0);
    expect(out.latencyP95Ms).toBe(0);
  });

  it("test_shape_session_detail_maps_member_traces", () => {
    const out = shapeSessionDetail({
      ...base,
      traces: [{ traceId: "t1", durationMs: 5, statusCode: "ok" }],
    });
    expect(out.traces).toEqual([{ traceId: "t1", durationMs: 5, statusCode: "ok" }]);
  });
});
