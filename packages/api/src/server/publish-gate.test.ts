import { readdirSync, readFileSync } from "node:fs";
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
const REQUIRED_GATES = ["gate-ci", "gate-contract", "gate-sast", "guard-release-on-main"] as const;

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
function assertImageIsGated(wf: Record<string, unknown>): void {
  const all = jobs(wf);
  const publishers = Object.entries(all).filter(([, j]) =>
    String(j?.["uses"] ?? "").endsWith("build-publish.yml"),
  );
  if (publishers.length === 0) throw new Error("no job calls build-publish.yml — did `image` get repointed?");
  if (all["image"]?.["uses"] !== "./.github/workflows/build-publish.yml") {
    throw new Error("the `image` job no longer calls ./.github/workflows/build-publish.yml");
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

    /**
     * The PR trigger must survive: it is the reviewer-facing check, and it is deliberately NOT
     * path-filtered (a filtered required check is never reported, leaving the PR unmergeable).
     */
    it("ci.yml keeps its pull_request trigger — the gate is additive, not a replacement", () => {
      expect(triggers(workflow("ci.yml"))).toHaveProperty("pull_request");
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
    });

    /** F-sec-1 — a secret with no consumer is pure surface handed to every future caller. */
    it.each(["gate-ci", "gate-contract", "gate-sast"])("%s is passed no secrets", (job) => {
      expect(jobs(workflow("publish.yml"))[job]).not.toHaveProperty("secrets");
    });

    /** F-sec-2/F-sec-4 — a standalone push trigger raced the gated call on the same concurrency group. */
    it.each(["ci.yml", "integration.yml", "security-sast.yml"])("%s has no standalone push trigger", (file) => {
      expect(triggers(workflow(file))).not.toHaveProperty("push");
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
    needs: [gate-ci, gate-contract, gate-sast, guard-release-on-main]
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
    needs: [gate-ci, gate-contract, gate-sast, guard-release-on-main]
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
});
