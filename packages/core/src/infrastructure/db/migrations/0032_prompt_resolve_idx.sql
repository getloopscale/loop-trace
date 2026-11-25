-- M15 (loopprompt) — o índice que torna o agregado de uso por revisão barato.
--
-- É a forma que a NOTE do M95 em `schema.ts` deixou explicitamente em aberto. Ela mediu, com
-- EXPLAIN, que uma GIN sobre `attributes` acelera contenção `@>` e NÃO o predicado
-- `attributes ->> key = value`, e diferiu "a true attr-value index" para um milestone próprio.
-- Este é esse milestone, e a forma é outra: B-tree sobre a EXPRESSÃO extraída, que serve
-- `->> key = value` diretamente.
--
-- PARCIAL (`WHERE name = 'prompt.resolve'`) porque só spans de resolução interessam: o índice
-- fica pequeno em proporção à tabela e não onera a ingestão dos outros produtos do ecossistema.
--
-- Sobre `prompt.id` porque quem precisa de índice é o FILTRO. `prompt.revision` é apenas a chave
-- do GROUP BY — indexá-la não evitaria varredura alguma. (E `prompt.id` carrega o NOME do prompt:
-- a nomenclatura mente desde o M5 do loopprompt, e renomear é breaking para quem já consulta.)
CREATE INDEX IF NOT EXISTS "spans_prompt_resolve_idx"
  ON "spans" USING btree (("attributes"->>'prompt.id'), "workspace_id", "ingested_at")
  WHERE "name" = 'prompt.resolve';
