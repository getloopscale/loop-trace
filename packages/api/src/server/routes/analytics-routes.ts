/**
 * M121 (D1) — agents catalog + analytics (tools / tool-drilldown / cost) read routes, extracted
 * verbatim out of `app.ts` to complete the Front-Controller extraction. Behavior-preserving move:
 * every route keeps its exact path, per-verb scope guard, status codes, and response shape. Mirrors
 * `dataset-routes.ts`: workspace-from-Principal (M22); the repo port is injected by `createApp`.
 */
import type { Hono } from "hono";

import {
  type TraceReadRepository,
  type AggregateRepository,
  agentCatalogResponseSchema,
  toolStatsResponseSchema,
  traceListResponseSchema,
  costByPeriodResponseSchema,
  usageByUserResponseSchema,
  promptUsageResponseSchema,
  MAX_PROMPT_USAGE_WINDOW_DAYS,
  MAX_BUCKET_POINTS,
  MAX_LIMIT,
  MAX_OFFSET,
  MAX_WINDOW_DAYS,
  type UsageByUserOptions,
  apiError,
} from "@looptrace/core";

import { getPrincipal, requireScopeOnPrincipal } from "../auth/middleware.js";
import { usageByUserReports, promptUsageReports } from "../metrics.js";

// M130 (ISP) — narrowed from the composite `SpanRepository` to the exact roles used:
// trace-read (listTracesForTool) + aggregates (agents/tool-stats/cost).
export function registerAnalyticsRoutes(app: Hono, repo: TraceReadRepository & AggregateRepository): void {
  app.get("/v1/agents", requireScopeOnPrincipal("observability:read"), async (c) => {
    // M32: the agents catalog (derived from `agent.*` span attributes), with health.
    const agents = await repo.aggregateAgents(getPrincipal(c).workspaceId);
    return c.json(agentCatalogResponseSchema.parse({ agents }), 200);
  });

  app.get("/v1/analytics/tools", requireScopeOnPrincipal("observability:read"), async (c) => {
    const stats = await repo.aggregateToolStats(getPrincipal(c).workspaceId);
    return c.json(toolStatsResponseSchema.parse(stats), 200);
  });

  app.get("/v1/analytics/tools/:toolName/traces", requireScopeOnPrincipal("observability:read"), async (c) => {
    const list = await repo.listTracesForTool(
      c.req.param("toolName"),
      undefined,
      getPrincipal(c).workspaceId,
    );
    return c.json(traceListResponseSchema.parse(list), 200);
  });

  // M15 (loopprompt) — uso por REVISÃO de um prompt. O workspace vem do Principal e NUNCA de
  // query param: um `?workspaceId=` aqui seria vazamento cross-tenant por desenho (M22).
  app.get("/v1/analytics/prompt-usage", requireScopeOnPrincipal("observability:read"), async (c) => {
    const promptName = c.req.query("prompt");
    if (promptName === undefined || promptName.trim() === "") {
      return c.json(apiError("INVALID_QUERY", "prompt is required"), 400);
    }
    // Fail-fast na janela (Rule 8): um valor fora de faixa é RECUSADO, não silenciosamente
    // trocado por um default — senão o chamador recebe uma janela diferente da que pediu e
    // atribui o resultado à janela errada.
    const rawWindow = c.req.query("windowDays");
    let windowDays = 7;
    if (rawWindow !== undefined) {
      const n = Number(rawWindow);
      if (!Number.isInteger(n) || n < 1 || n > MAX_PROMPT_USAGE_WINDOW_DAYS) {
        return c.json(
          apiError("INVALID_QUERY", `windowDays must be an integer in 1..${String(MAX_PROMPT_USAGE_WINDOW_DAYS)}`),
          400,
        );
      }
      windowDays = n;
    }
    const rows = await repo.aggregatePromptUsage(promptName, windowDays, getPrincipal(c).workspaceId);
    // Wiring-triad pilar (c): sem isto, a rota é invisível em produção quando pesar.
    promptUsageReports.add(1);
    return c.json(promptUsageResponseSchema.parse({ promptName, windowDays, rows }), 200);
  });

  app.get("/v1/analytics/cost", requireScopeOnPrincipal("observability:read"), async (c) => {
    // Whitelist the period (fail-fast on anything but day/week, Rule 8); default day.
    const raw = c.req.query("period");
    if (raw !== undefined && raw !== "day" && raw !== "week") {
      return c.json(apiError("INVALID_QUERY", "invalid period (use day or week)"), 400);
    }
    const result = await repo.aggregateCostByPeriod(
      raw === "week" ? "week" : "day",
      getPrincipal(c).workspaceId,
    );
    return c.json(costByPeriodResponseSchema.parse(result), 200);
  });

  // M140 — consumption grouped by END USER. Observability, not billing: looptrace reports what it
  // observed; loopzero-cloud is what charges. The workspace comes from the Principal and never from a
  // query param — a `?workspaceId=` here would be a cross-tenant leak by design (M22).
  app.get("/v1/analytics/usage-by-user", requireScopeOnPrincipal("observability:read"), async (c) => {
    // Fail-fast on each param (Rule 8): a non-numeric or out-of-range value is rejected rather than
    // silently defaulted, so a caller never receives a window different from the one it asked for.
    const num = (name: string): number | undefined | null => {
      const raw = c.req.query(name);
      if (raw === undefined) return undefined;
      const n = Number(raw);
      return Number.isInteger(n) && n > 0 ? n : null;
    };
    const days = num("days");
    const limit = num("limit");
    const offset = c.req.query("offset") === undefined ? undefined : Number(c.req.query("offset"));
    if (days === null || limit === null) {
      return c.json(apiError("INVALID_QUERY", "days and limit must be positive integers"), 400);
    }
    // Reject above the ceiling rather than clamping. Clamping `days` was at least observable
    // (`windowDays` is echoed); clamping `limit` was NOT — a caller asking for 100000 got 500 rows
    // with nothing saying so, then advanced `offset` by 100000 and read the wrong pages in silence.
    if (days !== undefined && days > MAX_WINDOW_DAYS) {
      return c.json(apiError("INVALID_QUERY", `days must be at most ${MAX_WINDOW_DAYS}`), 400);
    }
    if (limit !== undefined && limit > MAX_LIMIT) {
      return c.json(apiError("INVALID_QUERY", `limit must be at most ${MAX_LIMIT}`), 400);
    }
    if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
      return c.json(apiError("INVALID_QUERY", "offset must be a non-negative integer"), 400);
    }
    // `offset` was the only parameter with a shape check and no magnitude check, and the gap had
    // two edges. `Number.isInteger` accepts `1e21` and `99999999999999999999`, which sailed past
    // the line above and then died in the driver as `invalid input syntax for type bigint` — a
    // generic 500 where the two branches above promise a typed 400. And a merely large offset is
    // expensive: measured at 500k spans, `OFFSET 190000` doubled latency and spilled ~10 MB of
    // temp sort to disk, on a number the caller picks.
    if (offset !== undefined && offset > MAX_OFFSET) {
      return c.json(apiError("INVALID_QUERY", `offset must be at most ${MAX_OFFSET}`), 400);
    }
    // M143 — o eixo de tempo. `bucket` é aditivo: ausente, tudo abaixo é inerte e a resposta é a de
    // hoje, campo por campo (a tela da M142 está em produção lendo esse formato).
    const bucketRaw = c.req.query("bucket");
    if (bucketRaw !== undefined && bucketRaw !== "day") {
      // Recusar em vez de cair no default: um `bucket=week` aceito em silêncio devolveria série
      // DIÁRIA sob um nome semanal, e o gráfico plotaria a granularidade errada sem ninguém saber.
      return c.json(apiError("INVALID_QUERY", 'bucket must be "day"'), 400);
    }

    // O teto do PRODUTO, e não de cada parâmetro. MEDIDO (blueprint do M143, perfil denso em
    // Postgres 17 com o mesmo índice composto): `limit=50 × days=365` produz 18.250 pontos e
    // **1.591 kB** de JSON para uma tela, enquanto o uso real do gráfico (top-5 × 365) são 1.825
    // pontos / 101 kB / 18,9 ms. O tempo cresce 1,73× com o bucket; o RESULTADO cresce 365×.
    //
    // Um teto só em `days` ou só em `limit` não limita o que explode — `50 × 365` passa por
    // qualquer teto individual razoável. E devolver top-N em silêncio seria clampar, que é
    // exatamente o que as duas guardas acima recusam por princípio.
    //
    // A mensagem nomeia OS DOIS parâmetros: dizer só um deixa o chamador girando o botão errado.
    if (bucketRaw === "day") {
      // `days + 1`, e não `days`. A janela é ROLANTE (`now() - days`), não alinhada ao calendário,
      // então uma janela de N dias que comece no meio de um dia atravessa N+1 dias de calendário e
      // produz N+1 baldes. MEDIDO no review: `days=3` produziu **4** baldes. Sem o `+1` o teto
      // orçava menos pontos do que a resposta pode carregar — erro por um dia, não por ordem de
      // grandeza, mas o ADR-1 promete "o número de pontos no PIOR caso".
      const pontos = ((days ?? 30) + 1) * (limit ?? 50);
      if (pontos > MAX_BUCKET_POINTS) {
        return c.json(
          apiError(
            "INVALID_QUERY",
            `with bucket=day, (days + 1) × limit must be at most ${MAX_BUCKET_POINTS} (asked for ${(days ?? 30) + 1} × ${limit ?? 50} = ${pontos})`,
          ),
          400,
        );
      }
    }

    const opts: UsageByUserOptions = {};
    if (days !== undefined) opts.days = days;
    if (limit !== undefined) opts.limit = limit;
    if (offset !== undefined) opts.offset = offset;
    if (bucketRaw === "day") opts.bucket = "day";
    const result = await repo.aggregateUsageByUser(opts, getPrincipal(c).workspaceId);
    usageByUserReports.add(1);
    // The response concentrates client-chosen identities that MAY be PII (risk R1). Nothing shared
    // caches an Authorization-bearing response by default, so this is belt-and-braces rather than a
    // fix for an observed leak — but it is the one read whose body is a list of people, and the M141
    // BFF puts a proxy in front of it, which is where "by default" stops being a guarantee.
    c.header("Cache-Control", "private, no-store");
    return c.json(usageByUserResponseSchema.parse(result), 200);
  });
}
