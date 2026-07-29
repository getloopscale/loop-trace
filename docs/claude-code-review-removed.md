# Por que não há workflow de revisão automática do Claude aqui

Removidos em 2026-07-28, ao preparar a publicação. Eram `claude.yml` (Claude PR Assistant) e
`claude-code-review.yml` (Claude Code Review).

## O que estava acontecendo

Reprovavam em **100% dos runs desde 2026-07-20** — 0 sucessos. A causa não era o código:

```
App token exchange failed: 401 Unauthorized -
Claude Code is not installed on this repository.
```

O secret `CLAUDE_CODE_OAUTH_TOKEN` existia; o que faltava era a **instalação do GitHub App**.
Instalação de App pertence à conta, não ao repositório — transferir o repo para a org `usetheoai`
o tirou de baixo de qualquer instalação anterior. É a mesma pegadinha do runbook de migração para
a Blacksmith, cujo Passo 3 é literalmente "instalar o App NA ORG (não pule)". `gh api
orgs/usetheoai/installations` lista apenas `blacksmith-sh`.

Um check que sempre reprova é pior que um check ausente: some no ruído, obriga quem faz merge a
decidir a cada PR se "aquele vermelho é o de sempre", e treina o time a ignorar vermelho.

## Por que remover em vez de deixar quebrado até alguém instalar

Duas razões, e a segunda só passa a valer agora:

1. **Nove dias sem uma única execução útil.** Não era uma regressão recente esperando conserto.
2. **Este repositório vai ser público, e `claude.yml` disparava em `issue_comment`.** Esse gatilho
   roda no contexto do repo base **com acesso aos secrets**, e num repo público qualquer pessoa
   pode comentar numa issue. A action tem guardas próprias de permissão, mas manter uma superfície
   de acionamento por estranho — para um workflow que comprovadamente não funciona — é custo e
   risco sem nenhum benefício em troca.

Os dois também usavam `actions/checkout@v4` e `claude-code-action@v1`, refs **mutáveis**, num repo
que fixa as outras 40 actions por SHA de 40 caracteres. Foram fixados por SHA antes da remoção
(commit separado), porque a correção de supply-chain valia por si — inclusive para quem restaurar
os arquivos a partir do histórico.

## Como trazer de volta

1. Instalar https://github.com/apps/claude na org `usetheoai` com acesso a este repositório.
2. Confirmar: `gh api orgs/usetheoai/installations --jq '.installations[].app_slug'`.
3. Restaurar os arquivos do histórico (`git log --diff-filter=D -- .github/workflows/claude.yml`),
   **mantendo os SHAs fixados**.
4. Antes de religar `claude.yml` num repo público, decidir conscientemente sobre o gatilho
   `issue_comment` — restringir por associação do autor, ou não usá-lo.

Contexto completo: theo-lens#99.
