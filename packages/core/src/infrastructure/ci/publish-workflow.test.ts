/**
 * Contrato da cópia VENDORIZADA do `build-publish` (ROADMAP_CICD CM1/CM4).
 *
 * Este teste não exercita produto — ele guarda um acoplamento entre arquivos de CI que nenhum
 * compilador relaciona, e cujos modos de falha são todos SILENCIOSOS:
 *
 *  - a cópia sumir com a referência apontando para ela → o workflow morre no PARSE
 *    ("workflow was not found"), sem criar job algum e sem erro visível na aba Actions;
 *  - a referência voltar ao upstream com a cópia esquecida → ela diverge do original para
 *    sempre, e nada mais avisa;
 *  - o `--certificate-identity-regexp` do cosign apontar para outro repositório → a verificação
 *    não falha, ela ACEITA assinatura produzida pelo workflow daquele repo (confused-deputy).
 *    A cópia veio justamente de outro repo, então este é o erro mais provável de todos;
 *  - o compose de deploy puxar de um namespace diferente do que o build publica → CI verde e
 *    `403 Forbidden` só no deploy. Aconteceu de verdade no theo-rag (CM3).
 *
 * Quando `usetheodev/theo` migrar para `usetheoai`: apague `.github/workflows/build-publish.yml`,
 * devolva o `uses:` ao reusable e atualize este teste NO MESMO COMMIT. Se um andar sem o outro,
 * isto fica vermelho — que é o ponto.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../../../..');
const PUBLISH = resolve(REPO_ROOT, '.github/workflows/publish.yml');
const VENDORED = resolve(REPO_ROOT, '.github/workflows/build-publish.yml');
const DEPLOY_COMPOSE = resolve(REPO_ROOT, 'docker-compose.deploy.yml');

const LOCAL_REF = 'uses: ./.github/workflows/build-publish.yml';
const UPSTREAM_REF = 'uses: getloopscale/engine/.github/workflows/build-publish.yml';
const EXPECTED_IDENTITY =
  String.raw`^https://github\.com/usetheoai/theo-lens/\.github/workflows/build-publish\.yml@`;

const read = (p: string): string => readFileSync(p, 'utf8');

describe('vendored build-publish', () => {
  test('a cópia e a referência que aponta para ela andam juntas', () => {
    const publish = read(PUBLISH);
    const vendoredExists = existsSync(VENDORED);

    if (publish.includes(LOCAL_REF)) {
      expect(
        vendoredExists,
        'publish.yml aponta para a cópia local, mas ela não existe — o workflow morre no PARSE',
      ).toBe(true);
    }
    if (publish.includes(UPSTREAM_REF)) {
      expect(
        vendoredExists,
        'publish.yml voltou ao reusable upstream, mas a cópia ficou no repo — apague-a, ela diverge em silêncio',
      ).toBe(false);
    }
  });

  test('o cosign identity aponta para ESTE repositório', () => {
    if (!existsSync(VENDORED)) return; // sem cópia, o upstream é dono da própria identidade

    const vendored = read(VENDORED);
    expect(
      vendored.includes(EXPECTED_IDENTITY),
      'a cópia não fixa a identidade cosign em usetheoai/theo-lens',
    ).toBe(true);

    for (const foreign of ['usetheoai/theo-rag', 'usetheoai/theo-memory', 'usetheoai/theo-traefik-mcp']) {
      expect(
        vendored.includes(`${foreign}/.github/workflows/build-publish`),
        `identidade cosign ainda aponta para ${foreign} — assinatura daquele repo seria ACEITA aqui`,
      ).toBe(false);
    }
  });

  test('nenhuma linha ativa publica no namespace antigo', () => {
    if (!existsSync(VENDORED)) return;

    const vendored = read(VENDORED);
    expect(vendored).toContain('default: "ghcr.io/usetheoai"');

    // Comentários são ignorados de propósito: o cabeçalho EXPLICA por que o namespace antigo
    // não serve, e casar o arquivo inteiro sinalizaria a própria explicação como o defeito.
    const offending = vendored
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#') && l.includes('ghcr.io/usetheodev'));
    expect(
      offending,
      'linha ativa ainda aponta para ghcr.io/usetheodev — um run de usetheoai não tem push lá (403)',
    ).toEqual([]);
  });

  // A licao do theo-rag (CM3): o guard acima cobre o lado que EMPURRA a imagem, e o deploy
  // quebrou no lado que a PUXA — `403 Forbidden` no host, DEPOIS de o build ter passado e
  // publicado normalmente. Sao arquivos distintos, sem compilador nem tipo em comum.
  test('o compose de deploy puxa do MESMO namespace que o build publica', () => {
    const compose = readFileSync(DEPLOY_COMPOSE, 'utf8');

    const stale = compose
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#') && l.includes('ghcr.io/usetheodev'));
    expect(
      stale,
      'o compose de deploy puxa de ghcr.io/usetheodev — o host recebe 403 e o deploy falha com a CI verde',
    ).toEqual([]);

    expect(
      compose.includes('ghcr.io/usetheoai/theo-lens'),
      'o compose de deploy nao referencia a imagem publicada em ghcr.io/usetheoai',
    ).toBe(true);
  });

  test('a referência da imagem no cosign passa por env, não interpolada no run', () => {
    if (!existsSync(VENDORED)) return;

    // `${{ }}` dentro de `run:` é substituído no SHELL antes da execução: um valor com aspas,
    // `;` ou `$(...)` deixa de ser argumento e vira comando, com acesso ao GITHUB_TOKEN e ao
    // OIDC de assinatura. Um input de `workflow_call` é controlado pelo CALLER, e o conjunto
    // de callers muda sem este arquivo mudar — a barreira tem de valer por construção.
    const runLines = read(VENDORED)
      .split('\n')
      .filter((l) => /^\s*run:.*cosign/u.test(l) && l.includes('${{'));
    expect(runLines, 'cosign com ${{ }} interpolado direto no run — shell injection').toEqual([]);
  });
});
