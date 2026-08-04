import { z } from "zod";

/**
 * M15 (theo-promptly) — uso observado por REVISÃO de prompt.
 *
 * O `theo-promptly` marca `prompt.id` (que carrega o **nome** do prompt — a
 * nomenclatura mente desde o M5 daquele projeto, e renomear é breaking) e
 * `prompt.revision` em cada span `prompt.resolve`.
 *
 * A atribuição de custo é **por trace**, não por atributo negociado: o span de
 * resolução nasce filho do trace da aplicação — o SDK roda in-process —, então
 * ele e a chamada ao modelo compartilham `traceId` sem que nenhuma aplicação
 * consumidora precise marcar nada. O limite disso é honesto e precisa ser dito
 * na tela: uma app que resolve o prompt fora do trace em que chama o modelo não
 * correlaciona, e o custo aparece vazio — nunca zero.
 *
 * `costUsd` é `null` quando o `theo-lens` não soube precificar o modelo. Vazio
 * com razão, jamais estimado.
 */
export const promptUsageRowSchema = z
  .object({
    revision: z.number().int(),
    resolutions: z.number().int(),
    totalTokens: z.number().int(),
    costUsd: z.number().nullable(),
  })
  .strict();

export const promptUsageResponseSchema = z
  .object({
    promptName: z.string().min(1),
    windowDays: z.number().int().positive(),
    rows: z.array(promptUsageRowSchema),
  })
  .strict();

export type PromptUsageRow = z.infer<typeof promptUsageRowSchema>;
export type PromptUsageResponse = z.infer<typeof promptUsageResponseSchema>;

/** Teto da janela — um agregado "desde sempre" varre a tabela inteira. */
export const MAX_PROMPT_USAGE_WINDOW_DAYS = 90;
