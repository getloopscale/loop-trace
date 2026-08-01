/**
 * M139 — o dataset de eval: schema e carga.
 *
 * Domínio PURO (`rules/architecture.md` § 1): não lê arquivo, não conhece YAML nem filesystem.
 * Recebe um objeto já desserializado e devolve um dataset validado ou lança. Quem lê disco é o CLI
 * (`scripts/run-eval.mjs`), a única camada com I/O.
 *
 * A validação acontece na CARGA, não durante a execução — copiado do Phoenix
 * (`knowledge-base/references/phoenix/evals/pxi/harness/datasets.py:7-38`, pydantic com
 * `field_validator`). Um dataset que parseia PARCIALMENTE produziria um eval que mede menos do que
 * afirma e ainda reporta verde.
 */

import { z } from "zod";

import { spanSchema } from "../observability/span.js";
import { validatePredicate } from "./evaluator.js";

/**
 * Onde o dataset shipped vive, relativo à raiz do repositório. Declarado UMA vez: o CLI e o teste
 * do dataset shipped consomem esta constante em vez de cada um encodar o caminho. Duas encodações
 * independentes do mesmo fato significam que mover o arquivo e atualizar só uma delas deixa o teste
 * asseverando sobre um caminho que não existe, ou o CI avaliando um arquivo que ninguém testa.
 */
export const SHIPPED_DATASET_PATH = "evals/rule-evaluators.yaml";

/** `regression` gateia; `dev` roda e não gateia (Phoenix `run_experiment.py:238-259`). */
export const EVAL_SPLITS = ["regression", "dev"] as const;
export type EvalSplit = (typeof EVAL_SPLITS)[number];

/**
 * O veredito esperado. Comparação PARCIAL declarada (ADR D5): o runner confere apenas as chaves
 * presentes aqui. `evaluateRule` sempre devolve `score` E `label`, mas exigir os dois em todo
 * exemplo transformaria o dataset num formulário — e formulário longo é preenchido por copy-paste.
 * O preço da comparação parcial é que ela precisa ser explícita, e é: um `expected` vazio não
 * afirma nada e é recusado.
 */
const expectedSchema = z
  .object({
    score: z.number().optional(),
    label: z.string().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, {
    message: "expected must declare at least one of `score` or `label` — an empty expected asserts nothing",
  });

/**
 * O evaluator sob teste. Só `rule` por ora: é determinístico e portanto gateável sem flakiness.
 * O `llm_judge` é estocástico e pertence ao tier medido, que testa CONTRATO e não valor.
 */
const ruleEvaluatorSchema = z
  .object({
    kind: z.literal("rule"),
    name: z.string().min(1),
    config: z.object({
      predicate: z
        .string()
        .min(1, "predicate must not be empty — an empty predicate is match-all and would match every span (EC-1)"),
    }),
    passLabel: z.string().optional(),
    failLabel: z.string().optional(),
  })
  .strict()
  .superRefine((ev, ctx) => {
    // `validatePredicate` aceita string vazia (match-all explícito, legítimo na API do produto);
    // o `.min(1)` acima já barrou esse caso. O que sobra aqui é o predicado NÃO-vazio que parseia
    // para zero cláusulas — mesmo efeito (casa todo span), gatilho diferente (EC-3).
    const problem = validatePredicate(ev.config.predicate);
    if (problem !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem, path: ["config", "predicate"] });
    }
  });

const exampleSchema = z
  .object({
    id: z.string().min(1),
    splits: z.array(z.enum(EVAL_SPLITS)).min(1, "each example needs at least one split"),
    evaluator: ruleEvaluatorSchema,
    span: spanSchema,
    /** EC-4 — sem isto, um predicado sobre `kind:"chain"` é inexprimível (`evaluator.ts:106,118`). */
    hasChildren: z.boolean().default(false),
    expected: expectedSchema,
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const evalDatasetSchema = z
  .object({
    dataset_name: z.string().min(1, "dataset_name cannot be empty"),
    description: z.string().optional(),
    examples: z.array(exampleSchema).min(1, "a dataset needs at least one example"),
  })
  .strict()
  .superRefine((d, ctx) => {
    // Ids duplicados fazem dois exemplos colidirem e a contagem por split MENTIR — o relatório
    // diria "8 em regression" com 7 distintos. É o erro que copy-paste produz.
    const seen = new Set<string>();
    for (const ex of d.examples) {
      if (seen.has(ex.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate example id: ${ex.id}` });
      }
      seen.add(ex.id);
    }
  });

export type EvalDataset = z.infer<typeof evalDatasetSchema>;
export type EvalExample = EvalDataset["examples"][number];

/**
 * Valida e devolve o dataset. Lança um erro cuja mensagem NOMEIA o campo e, quando aplicável, o
 * `id` do exemplo — um gate que diz apenas "inválido" custa uma hora de diagnóstico.
 */
export function parseEvalDataset(raw: unknown): EvalDataset {
  const result = evalDatasetSchema.safeParse(raw);
  if (result.success) return result.data;

  const lines = result.error.issues.map((issue) => {
    const path = issue.path.join(".");
    // O índice numérico do array não diz nada a quem lê; o `id` do exemplo diz.
    const idx = issue.path[1];
    const example =
      issue.path[0] === "examples" && typeof idx === "number"
        ? (raw as { examples?: { id?: unknown }[] })?.examples?.[idx]?.id
        : undefined;
    const where = example !== undefined ? `examples[${String(example)}].${issue.path.slice(2).join(".")}` : path;
    return `  ${where || "(root)"}: ${issue.message}`;
  });
  throw new Error(`invalid eval dataset:\n${lines.join("\n")}`);
}
