import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * M137 — the publish gate, pinned by execution rather than by review.
 *
 * WHY THIS FILE EXISTS. `publish.yml`'s `image` job used to declare no `needs:`, so `ci`,
 * `integration` and `security-sast` ran *beside* the build instead of before it: a red gate did not
 * stop the push, and the `:develop` tag the dev host reconciles could point at an artifact from a
 * rejected commit. theo-rag closed the identical defect (#160) quoting the measured consequence on
 * theo-memory — 11 of 134 pushes (8.2%) published an image with the suite red on the same commit.
 *
 * A comment saying "do not remove this" does not survive a refactor. This test does.
 *
 * HONEST NOTE (blueprint Q1): pinning a workflow with a test is STRICTER than the OSS field —
 * across opik, langfuse, phoenix, argo-cd and compose, only the first-party theo-memory does it
 * (`tests/integration/publish-workflow.test.ts`, 46 cases). It is our standard, adopted knowingly.
 *
 * The workflows are PARSED, never grepped. A grep for `needs:` passes on a commented-out line and on
 * a `needs:` belonging to any other job — precisely the false confidence this file must not give.
 */

const WORKFLOWS = process.env["WF_DIR"] ?? resolve(__dirname, "../../../../.github/workflows");

function workflow(name: string): Record<string, unknown> {
  return parse(readFileSync(resolve(WORKFLOWS, name), "utf8")) as Record<string, unknown>;
}

/**
 * `yaml@2` implements YAML **1.2**, whose core schema leaves `on` a plain string key — verified:
 * `Object.keys(parse(ci.yml))` → `['name','on','permissions','jobs']`. The first version carried a
 * `wf[true]` fallback for the YAML 1.1 "Norway problem"; it was unreachable dead code (and would
 * have read the string key `"true"` anyway, since JS stringifies property keys).
 */
function triggers(wf: Record<string, unknown>): Record<string, unknown> {
  return (wf["on"] ?? {}) as Record<string, unknown>;
}

function jobs(wf: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return (wf["jobs"] ?? {}) as Record<string, Record<string, unknown>>;
}

/** Every gate the `image` job must wait on. Adding one here is what makes the pin fail loudly. */
const REQUIRED_GATES = ["gate-ci", "gate-contract", "gate-sast", "gate-eval", "guard-release-on-main"] as const;

/**
 * THE assertion, extracted so the negative cases can run the REAL one instead of re-implementing
 * its inverse by hand (M137 review, F-xval-8). A negative case that asserts on a fixture without
 * touching the guarding logic proves the fixture is malformed, not that the guard would fire.
 */
function assertJobIsGated(name: string, job: Record<string, unknown> | undefined): void {
  const needs = job?.["needs"];
  if (needs === undefined) throw new Error(`${name} declares no needs: — the gate is gone`);
  const list = (Array.isArray(needs) ? needs : [needs]).map(String);
  const missing = REQUIRED_GATES.filter((g) => !list.includes(g));
  if (missing.length > 0) throw new Error(`${name} is missing gate(s): ${missing.join(", ")}`);

  // `needs:` is NECESSARY BUT NOT SUFFICIENT. `if: always()` (and `!cancelled()`, and
  // `success() || …`) OVERRIDE needs-failure propagation: the job runs even after its gates fail.
  // Pinning only the declaration would let one line reopen the exact hole M137 closes, with this
  // test green. Found by the review's mutation harness — the mutation survived the first version.
  const cond = String(job?.["if"] ?? "");
  if (/always\s*\(|!\s*cancelled\s*\(|success\s*\(\s*\)\s*\|\|/.test(cond)) {
    throw new Error(`${name} has an if: that defeats needs: (${cond}) — gates would not block it`);
  }
}

/**
 * Every job that publishes must be gated — not merely the one named `image`. A second publishing
 * job (`image-hotfix: uses: build-publish.yml`) survived the first version untouched, and so did
 * repointing `image` at a different workflow. Quantify over the effect, not over the name.
 */
// The reusable can be referenced two ways, and BOTH must be recognised as publishing:
// the vendored copy (`./.github/workflows/build-publish.yml`) and the upstream one
// (`getloopscale/engine/.github/workflows/build-publish.yml@<ref>`). Matching only the local
// form is what let the org-migration cutover pass the file while this gate went blind.
const CALLS_BUILD_PUBLISH = /(^\.\/\.github\/workflows\/|\/)build-publish\.yml(@.+)?$/u;

function assertImageIsGated(wf: Record<string, unknown>): void {
  const all = jobs(wf);
  const publishers = Object.entries(all).filter(([, j]) =>
    CALLS_BUILD_PUBLISH.test(String(j?.["uses"] ?? "")),
  );
  if (publishers.length === 0) throw new Error("no job calls build-publish.yml — did `image` get repointed?");
  if (!CALLS_BUILD_PUBLISH.test(String(all["image"]?.["uses"] ?? ""))) {
    throw new Error("the `image` job no longer calls build-publish.yml");
  }
  for (const [name, job] of publishers) assertJobIsGated(name, job);
}

/**
 * F-test-3 — the path-filter check, extracted so its negative case can run the REAL assertion
 * instead of asserting on a fixture. Gutting the inline version left 17/17 green.
 */
function assertPublishUsesDenylist(wf: Record<string, unknown>): void {
  const push = triggers(wf)["push"] as Record<string, unknown> | undefined;
  if (push?.["paths"] !== undefined) {
    throw new Error("publish.yml uses a positive allowlist — a release that does not match vanishes silently");
  }
  const ignore = push?.["paths-ignore"];
  if (!Array.isArray(ignore) || ignore.length === 0) {
    throw new Error("publish.yml declares no paths-ignore — docs-only pushes run every gate");
  }
}

describe("M137 — publication gates", () => {
  describe("the gates are callable (T1.1)", () => {
    it.each(["ci.yml", "integration.yml"])(
      "%s declares workflow_call, without which it cannot be a gate",
      (file) => {
        expect(triggers(workflow(file))).toHaveProperty("workflow_call");
      },
    );

    // Inverted on purpose: `604b7ce` (owner decision, 2026-08-12) removed every `pull_request`
    // trigger — the pipeline runs only on merge, through the gated `publish.yml`. The assertion
    // above it was never updated, and it went unnoticed because the lint step failed first on every
    // develop push after it, so the unit-test step never ran.
    it("ci.yml has no pull_request trigger — CI runs only on merge, as a gate", () => {
      expect(triggers(workflow("ci.yml"))).not.toHaveProperty("pull_request");
    });
  });

  describe("the image waits for the suite (T1.2)", () => {
    it("image declares needs on every gate and the release guard", () => {
      expect(() => assertImageIsGated(workflow("publish.yml"))).not.toThrow();
    });

    it("the gate jobs call the local workflows, not a copy of their steps", () => {
      const j = jobs(workflow("publish.yml"));
      expect(j["gate-ci"]?.["uses"]).toBe("./.github/workflows/ci.yml");
      expect(j["gate-contract"]?.["uses"]).toBe("./.github/workflows/integration.yml");
      expect(j["gate-sast"]?.["uses"]).toBe("./.github/workflows/security-sast.yml");
      expect(j["gate-eval"]?.["uses"]).toBe("./.github/workflows/eval.yml");
    });

    /**
     * As três asserções abaixo eram listas LITERAIS mantidas à mão, e o `/review` da M139 provou
     * por mutação o que isso custa: `gate-eval` não estava em nenhuma delas, então repointar
     * `gate-eval` para `ci.yml` — o eval nunca roda, e o check aparece VERDE porque ci.yml é
     * verde — deixava 45/45 testes passando. Re-adicionar um `push:` a `eval.yml`, o defeito exato
     * do F-sec-2, também passava.
     *
     * Agora derivam de `publish.yml`: qualquer job `gate-*` entra automaticamente, e o próximo gate
     * fica coberto sem ninguém lembrar de estender uma lista. É a diferença entre um teste que pina
     * o que existe e um que pina a REGRA.
     */
    const GATE_JOBS = Object.entries(jobs(workflow("publish.yml")))
      .filter(([name, def]) => name.startsWith("gate-") && String(def?.["uses"] ?? "").startsWith("./.github/workflows/"))
      .map(([name, def]) => [name, String(def!["uses"]).replace("./.github/workflows/", "")] as const);

    it("the derivation found the gates (guards the guard)", () => {
      // Uma derivação que casasse zero jobs tornaria todo `it.each` abaixo vacuamente verde.
      expect(GATE_JOBS.length).toBeGreaterThanOrEqual(4);
      expect(GATE_JOBS.map(([n]) => n)).toContain("gate-eval");
    });

    /** F-sec-1 — a secret with no consumer is pure surface handed to every future caller. */
    it.each(GATE_JOBS)("%s is passed no secrets", (job) => {
      expect(jobs(workflow("publish.yml"))[job]).not.toHaveProperty("secrets");
    });

    /** F-sec-2/F-sec-4 — a standalone push trigger raced the gated call on the same concurrency group. */
    it.each(GATE_JOBS)("%s's workflow has no standalone push trigger", (_job, file) => {
      expect(triggers(workflow(file))).not.toHaveProperty("push");
    });

    /** Um gate cujo alvo não declara `workflow_call` reprova no PARSE — startup_failure, 0 jobs. */
    it.each(GATE_JOBS)("%s's workflow declares workflow_call", (_job, file) => {
      expect(triggers(workflow(file))).toHaveProperty("workflow_call");
    });
  });

  describe("a tag off main cannot publish :latest (T1.3)", () => {
    /**
     * Polarity matters. The first version asserted only `toContain("refs/tags/v")`, which a NEGATED
     * condition (`!startsWith(...)`) also satisfies — the guard would then run on everything except
     * the tags it exists to guard. The review's mutation harness proved that survived.
     */
    it("the guard fires ON tags, not on their negation", () => {
      const guard = jobs(workflow("publish.yml"))["guard-release-on-main"];
      expect(guard, "the guard job must exist").toBeDefined();
      const ifs = ((guard?.["steps"] ?? []) as Array<Record<string, unknown>>)
        .map((s) => String(s["if"] ?? ""))
        .filter(Boolean);
      expect(ifs.some((c) => /^\$\{\{\s*startsWith\(github\.ref,\s*'refs\/tags\/v'\)\s*\}\}$/.test(c))).toBe(true);
    });

    /**
     * A guard that cannot fail is decoration. Gutting the body to `echo "TODO re-enable ..."` kept
     * the substring `compare/main` and passed the first version — so assert the failure path too.
     */
    it("the guard can actually fail: compares against main, exits non-zero, fails on error", () => {
      const guard = jobs(workflow("publish.yml"))["guard-release-on-main"];
      const run = ((guard?.["steps"] ?? []) as Array<Record<string, unknown>>)
        .map((s) => String(s["run"] ?? ""))
        .join("\n");
      expect(run).toContain("compare/main");
      expect(run, "the guard must have a non-zero exit path").toMatch(/exit\s+1/);
      expect(run, "an API/network error must abort, not pass").toContain("set -euo pipefail");
    });
  });

  describe("docs-only work does not consume the pipeline (T2.2 / ADR D2 revised)", () => {
    /**
     * The filter lives in the CALLER. A callee's path filter is not evaluated for a `workflow_call`
     * invocation, so a filter on ci.yml would not have stopped the gated run (F-sec-6).
     */
    it("publish.yml filters docs-only pushes", () => {
      expect(() => assertPublishUsesDenylist(workflow("publish.yml"))).not.toThrow();
      const push = triggers(workflow("publish.yml"))["push"] as Record<string, unknown>;
      expect(push?.["paths-ignore"]).toEqual(
        expect.arrayContaining(["**/*.md", "docs/**", "knowledge-base/**", ".claude/**"]),
      );
    });

    /**
     * ADR D2 REVISED. The allowlist argument (loud vs silent failure) holds for a code-only trigger,
     * but this trigger also listens on `tags: ["v*"]` and path filters apply to tag pushes: a
     * positive list would make a release whose commit did not match vanish with no image and no
     * error. The first draft also proved the practical cost — its allowlist omitted `scripts/**`,
     * which `pnpm build` executes.
     */
    it("publish.yml uses a denylist, never an allowlist — a release must not vanish silently", () => {
      expect(() => assertPublishUsesDenylist(workflow("publish.yml"))).not.toThrow();
    });
  });

  /**
   * M138 — the repo must hold no host credential. theo-lens is Apache-2.0 and headed for
   * publication; the umbrella runbook is explicit that a public repo carries no IP, path, user or
   * SSH key. Unlike most debt this does not undo itself — a published history is public
   * retroactively — so the absence is pinned rather than trusted to review.
   */
  describe("no host credentials remain (M138)", () => {
    it("publish.yml has no deploy job", () => {
      expect(jobs(workflow("publish.yml"))).not.toHaveProperty("deploy-dev");
    });

    it.each(["DEV_SSH_KEY", "DEV_HOST", "DEV_DEPLOY_DIR"])(
      "%s is not referenced in any workflow expression",
      (name) => {
        const files = ["publish.yml", "ci.yml", "integration.yml", "security-sast.yml"];
        for (const f of files) {
          const raw = readFileSync(resolve(WORKFLOWS, f), "utf8");
          // Strip comments: the removal rationale legitimately NAMES the old variables.
          const code = raw.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
          expect(code, `${f} still uses ${name}`).not.toContain(name);
        }
      },
    );
  });

  /**
   * NEGATIVE CASE (`rules/testing.md` § 4.1). Everything above proves the gate is PRESENT. This
   * proves the assertions can still FAIL — a test that only ever sees a correct file cannot tell you
   * it would notice a wrong one, and a gate-pinning test that cannot detect removal is theatre.
   */
  describe("the pin can actually detect removal", () => {
    it("a publish.yml with needs: stripped fails the REAL assertion", () => {
      const stripped = parse(`
name: Publish
on: { push: { branches: [develop] } }
jobs:
  image:
    uses: ./.github/workflows/build-publish.yml
`) as Record<string, unknown>;
      expect(() => assertImageIsGated(stripped)).toThrow(/declares no needs/);
    });

    /**
     * The mutation the first version could NOT catch (M137 review, F-xval-8): removing ONE gate
     * rather than all of them. `arrayContaining` on a hand-rolled inverse never exercised this.
     */
    it("a PARTIAL removal — one gate dropped — still fails", () => {
      const partial = parse(`
name: Publish
on: { push: { branches: [develop] } }
jobs:
  image:
    needs: [gate-ci]
    uses: ./.github/workflows/build-publish.yml
`) as Record<string, unknown>;
      expect(() => assertImageIsGated(partial)).toThrow(/missing gate\(s\)/);
    });

    it("a publish.yml using a positive allowlist fails the REAL assertion", () => {
      const allowlisted = parse(`
name: Publish
on: { push: { branches: [develop], tags: ["v*"], paths: ["packages/**"] } }
jobs: { image: { uses: ./.github/workflows/build-publish.yml } }
`) as Record<string, unknown>;
      expect(() => assertPublishUsesDenylist(allowlisted)).toThrow(/allowlist/);
    });

    /** BLOCKER from the review: `if: always()` republishes with every gate red. */
    it("an image job with if: always() is rejected — needs: alone does not block it", () => {
      const defeated = parse(`
name: Publish
on: { push: { branches: [develop] } }
jobs:
  image:
    needs: [gate-ci, gate-contract, gate-sast, gate-eval, guard-release-on-main]
    if: \${{ always() }}
    uses: ./.github/workflows/build-publish.yml
`) as Record<string, unknown>;
      expect(() => assertImageIsGated(defeated)).toThrow(/defeats needs/);
    });

    /** A SECOND publishing job would have shipped ungated under the name-scoped first version. */
    it("a second, ungated publishing job is rejected", () => {
      const smuggled = parse(`
name: Publish
on: { push: { branches: [develop] } }
jobs:
  image:
    needs: [gate-ci, gate-contract, gate-sast, gate-eval, guard-release-on-main]
    uses: ./.github/workflows/build-publish.yml
  image-hotfix:
    uses: ./.github/workflows/build-publish.yml
`) as Record<string, unknown>;
      expect(() => assertImageIsGated(smuggled)).toThrow(/image-hotfix/);
    });
  });

  /**
   * F-7 — the checks above read four workflows BY NAME. The repo has nine, and nothing stopped a
   * tenth from calling build-publish.yml: `sdk-go.yml` gaining a publish step would ship ungated
   * while every assertion above stayed green. The gate has to quantify over the DIRECTORY, not
   * over a list someone has to remember to extend.
   */
  describe("no ungated publisher anywhere in .github/workflows (F-7)", () => {
    const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

    it("the sweep actually sees the whole directory", () => {
      // Guards the guard: a glob that silently matched nothing would make every case below vacuous.
      expect(files.length).toBeGreaterThanOrEqual(9);
      expect(files).toContain("publish.yml");
    });

    it.each(files)("%s declares no ungated caller of build-publish.yml", (file) => {
      // build-publish.yml IS the publisher; it is reusable and gated by its callers, not by itself.
      if (file === "build-publish.yml") return;
      for (const [name, job] of Object.entries(jobs(workflow(file)))) {
        if (String(job?.["uses"] ?? "").endsWith("build-publish.yml")) {
          assertJobIsGated(`${file}:${name}`, job);
        }
      }
    });
  });

  /**
   * Encontrado por MUTAÇÃO ao adicionar `gate-eval` (M139): deletar `eval.yml` não fazia nenhum
   * teste falhar, embora `publish.yml` continuasse declarando `uses: ./.github/workflows/eval.yml`.
   * O GitHub reprova isso no PARSE — `workflow was not found` — e um run que morre no parse aparece
   * como `startup_failure`: run criado, zero jobs, 0s. Quem olha a lista vê vermelho e presume que
   * o gate rodou e reprovou. É a mesma família do defeito que custou 30 runs ao theo-memory
   * (`eval.yml:43-51`): o estado do check não prova que o check executou.
   */
  describe("every local workflow reference resolves (found by mutation, M139)", () => {
    const files = readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f));

    it.each(files)("%s references only workflows that exist AND are callable", (file) => {
      for (const [job, def] of Object.entries(jobs(workflow(file)))) {
        const uses = String(def?.["uses"] ?? "");
        if (!uses.startsWith("./.github/workflows/")) continue;
        const target = uses.replace("./.github/workflows/", "");
        if (!existsSync(resolve(WORKFLOWS, target))) {
          throw new Error(`${file}:${job} calls ${uses}, which does not exist`);
        }
        // EXISTIR NÃO BASTA — o alvo precisa declarar `workflow_call:`. Sem ele o GitHub reprova a
        // chamada no PARSE, e um run que morre no parse aparece como `startup_failure`: criado, zero
        // jobs, 0s. A lista de checks mostra vermelho e quem olha conclui que o gate rodou e
        // reprovou. Este par de asserções cobre as duas metades: o arquivo existe, e ele é chamável.
        if (triggers(workflow(target))["workflow_call"] === undefined) {
          throw new Error(`${file}:${job} calls ${uses}, which does not declare \`workflow_call:\``);
        }
      }
    });
  });

  /**
   * F-test-2 do review. O gate podia estar cabeado, nomeado, chamável e verde — e ainda assim
   * incapaz de reprovar: remover `--fail-on-regression` do comando deixava 45/45 passando. O
   * workflow rodava o eval, via a regressão, e saía 0. Nada pinava que o passo que GATEIA carrega
   * a flag que o faz gatear.
   */
  describe("the eval gate's command actually gates (F-test-2)", () => {
    const evalJob = jobs(workflow("eval.yml"))["eval"] as Record<string, unknown> | undefined;
    const steps = (evalJob?.["steps"] ?? []) as Array<Record<string, unknown>>;
    const gating = steps.filter((st) => {
      const run = String(st["run"] ?? "");
      return run.includes("run-eval.mjs") && run.includes("--splits regression");
    });

    it("exactly one step runs the regression split", () => {
      expect(gating).toHaveLength(1);
    });

    it("that step carries --fail-on-regression", () => {
      expect(String(gating[0]?.["run"] ?? "")).toContain("--fail-on-regression");
    });

    it("that step is NOT continue-on-error", () => {
      // `continue-on-error: true` existe no passo do split `dev`, logo abaixo. Aplicá-lo ao passo
      // que gateia deixaria o job verde sobre uma regressão — e nada impedia isso.
      expect(gating[0]).not.toHaveProperty("continue-on-error");
    });
  });

  /**
   * usetheoai/theo#446 — the platform runs theo-lens from Amazon ECR by commit SHA, so the image job
   * must reach the ECR-capable reusable and hand it the registry and the role.
   *
   * Two failure modes are pinned here, and both are SILENT at startup — GitHub refuses the whole
   * workflow with no job and no log:
   *   - passing an input the pinned reusable does not declare (an `attest:` did exactly this in a
   *     sibling repo, five runs dead in under a second);
   *   - granting the job fewer permissions than the reusable declares.
   */
  describe("the image reaches Amazon ECR (usetheoai/theo#446)", () => {
    const REUSABLE =
      "getloopscale/engine/.github/workflows/build-publish.yml@1596e81f2ab64a4eb08a7d180e33639138f96b7f";
    /** Declared by the reusable at the pinned SHA — `on.workflow_call.inputs`. */
    const DECLARED_INPUTS = [
      "image", "dockerfile", "context", "registry", "build_args", "sign", "verify", "trivy",
      "dockerhub_image", "runner", "ecr_registry", "aws_role_arn",
    ];
    /** Declared by the reusable at the pinned SHA — its top-level `permissions:`. */
    const REUSABLE_PERMISSIONS = {
      contents: "read",
      packages: "write",
      "id-token": "write",
      attestations: "write",
    };

    function assertInputsAreDeclared(job: Record<string, unknown> | undefined): void {
      const passed = Object.keys((job?.["with"] ?? {}) as Record<string, unknown>);
      const undeclared = passed.filter((k) => !DECLARED_INPUTS.includes(k));
      if (undeclared.length > 0) {
        throw new Error(`image passes input(s) the reusable does not declare: ${undeclared.join(", ")}`);
      }
    }

    const image = () => jobs(workflow("publish.yml"))["image"];

    it("image calls the ECR-capable reusable at its pinned SHA", () => {
      expect(image()?.["uses"]).toBe(REUSABLE);
    });

    it("image passes only inputs the pinned reusable declares", () => {
      expect(() => assertInputsAreDeclared(image())).not.toThrow();
    });

    it("an undeclared input is refused (negative case)", () => {
      expect(() => assertInputsAreDeclared({ with: { image: "theo-lens", attest: true } })).toThrow(/attest/);
    });

    it("the ECR registry and role come from repository variables, never from text", () => {
      const w = (image()?.["with"] ?? {}) as Record<string, unknown>;
      expect(w["ecr_registry"]).toBe("${{ vars.ECR_REGISTRY }}");
      expect(w["aws_role_arn"]).toBe("${{ vars.AWS_IMAGE_PUBLISH_ROLE_ARN }}");
    });

    it("the ECR repository is named after the one image this service runs", () => {
      expect(((image()?.["with"] ?? {}) as Record<string, unknown>)["image"]).toBe("theo-lens");
    });

    it("image grants every permission the reusable declares", () => {
      expect(image()?.["permissions"]).toEqual(REUSABLE_PERMISSIONS);
    });
  });
});
