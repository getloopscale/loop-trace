import { describe, it, expect } from "vitest";
import type { AuthVerifier, Principal, SpanRepository } from "@looptrace/core";

import { createApp } from "./app.js";
import { promptUsageReports } from "./metrics.js";

/**
 * M15 (loopprompt) — a rota `GET /v1/analytics/prompt-usage` na fronteira HTTP.
 *
 * O que a integração contra Postgres já prova é a CONSULTA. O que só aqui se prova é a
 * fronteira: o workspace vem do Principal e nunca de query param, a janela inválida é
 * recusada em vez de silenciosamente trocada, e a rota é observável em produção.
 */

function verifierFor(map: Record<string, Principal>): AuthVerifier {
  return {
    resolvePrincipal: async (token) => map[token] ?? null,
    verify: async (token) => map[token] !== undefined,
  };
}

function principal(scopes: string[], workspaceId = "ws-x"): Principal {
  return { workspaceId, userId: "u", role: "member", scopes };
}

/** Repo stub que registra os argumentos com que o agregado foi chamado. */
function repoStub(): { repo: SpanRepository; visto: () => unknown[] } {
  let args: unknown[] = [];
  const repo = {
    aggregatePromptUsage: async (...a: unknown[]) => {
      args = a;
      return [{ revision: 6, resolutions: 12, totalTokens: 1500, costUsd: 0.031, p50LatencyMs: 4.2 }];
    },
  } as unknown as SpanRepository;
  return { repo, visto: () => args };
}

function app(repo: SpanRepository) {
  return createApp(repo, undefined, {
    verifier: verifierFor({ bom: principal(["observability:read"]) }),
    requireCredential: true,
  });
}

describe("GET /v1/analytics/prompt-usage", () => {
  it("o workspace vem do Principal, NUNCA de query param", async () => {
    // Um `?workspaceId=` aceito aqui seria vazamento cross-tenant por desenho (M22).
    const { repo, visto } = repoStub();

    const res = await app(repo).request(
      "/v1/analytics/prompt-usage?prompt=saudacao&workspaceId=ws-do-vizinho",
      { headers: { Authorization: "Bearer bom" } },
    );

    expect(res.status).toBe(200);
    expect(visto()[2], "o workspace do query param venceu o do Principal").toBe("ws-x");
  });

  it("prompt ausente é recusado na fronteira", async () => {
    const { repo } = repoStub();

    const res = await app(repo).request("/v1/analytics/prompt-usage", {
      headers: { Authorization: "Bearer bom" },
    });

    expect(res.status).toBe(400);
  });

  it("janela fora de faixa é RECUSADA, não trocada em silêncio", async () => {
    // Trocar em silêncio faria o chamador atribuir o resultado a um período diferente
    // do que pediu — e a tela mostra a janela, então mentiria junto.
    const { repo, visto } = repoStub();

    const res = await app(repo).request("/v1/analytics/prompt-usage?prompt=x&windowDays=9999", {
      headers: { Authorization: "Bearer bom" },
    });

    expect(res.status).toBe(400);
    expect(visto(), "a consulta saiu com uma janela inválida").toHaveLength(0);
  });

  it("sem o escopo observability:read, recusa", async () => {
    const { repo } = repoStub();
    const semEscopo = createApp(repo, undefined, {
      verifier: verifierFor({ magro: principal([]) }),
      requireCredential: true,
    });

    const res = await semEscopo.request("/v1/analytics/prompt-usage?prompt=x", {
      headers: { Authorization: "Bearer magro" },
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("a rota é observável em produção — wiring-triad pilar (c)", async () => {
    const { repo } = repoStub();
    const antes = promptUsageReports.value;

    await app(repo).request("/v1/analytics/prompt-usage?prompt=saudacao", {
      headers: { Authorization: "Bearer bom" },
    });

    expect(promptUsageReports.value).toBe(antes + 1);
  });
});
