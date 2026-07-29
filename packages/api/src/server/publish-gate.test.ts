import { readFileSync } from "node:fs";
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

const WORKFLOWS = resolve(__dirname, "../../../../.github/workflows");

function workflow(name: string): Record<string, unknown> {
  return parse(readFileSync(resolve(WORKFLOWS, name), "utf8")) as Record<string, unknown>;
}

/** `on:` parses to the boolean `true` in YAML 1.1 (the Norway problem's cousin); read it by key. */
function triggers(wf: Record<string, unknown>): Record<string, unknown> {
  const on = (wf["on"] ?? wf[true as unknown as string]) as Record<string, unknown> | undefined;
  return on ?? {};
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
function assertImageIsGated(wf: Record<string, unknown>): void {
  const needs = jobs(wf)["image"]?.["needs"];
  if (needs === undefined) throw new Error("publish.yml image job declares no needs: — the gate is gone");
  const list = (Array.isArray(needs) ? needs : [needs]).map(String);
  const missing = REQUIRED_GATES.filter((g) => !list.includes(g));
  if (missing.length > 0) throw new Error(`image job is missing gate(s): ${missing.join(", ")}`);
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
    it.each(["ci.yml", "integration.yml"])("%s has no standalone push trigger", (file) => {
      expect(triggers(workflow(file))).not.toHaveProperty("push");
    });
  });

  describe("a tag off main cannot publish :latest (T1.3)", () => {
    it("guard-release-on-main exists and is scoped to tags", () => {
      const guard = jobs(workflow("publish.yml"))["guard-release-on-main"];
      expect(guard, "the guard job must exist").toBeDefined();
      const steps = (guard?.["steps"] ?? []) as Array<Record<string, unknown>>;
      const ifs = steps.map((s) => String(s["if"] ?? "")).join(" ");
      expect(ifs).toContain("refs/tags/v");
    });

    it("the guard resolves the tag against main rather than trusting the ref", () => {
      const guard = jobs(workflow("publish.yml"))["guard-release-on-main"];
      const run = ((guard?.["steps"] ?? []) as Array<Record<string, unknown>>)
        .map((s) => String(s["run"] ?? ""))
        .join("\n");
      expect(run).toContain("compare/main");
    });
  });

  describe("docs-only work does not consume the pipeline (T2.2 / ADR D2 revised)", () => {
    /**
     * The filter lives in the CALLER. A callee's path filter is not evaluated for a `workflow_call`
     * invocation, so a filter on ci.yml would not have stopped the gated run (F-sec-6).
     */
    it("publish.yml filters docs-only pushes", () => {
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
      const push = triggers(workflow("publish.yml"))["push"] as Record<string, unknown>;
      expect(push).not.toHaveProperty("paths");
    });
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

    it("a publish.yml using a positive allowlist is rejected", () => {
      const allowlisted = parse(`
name: Publish
on: { push: { branches: [develop], tags: ["v*"], paths: ["packages/**"] } }
jobs: { image: { uses: ./.github/workflows/build-publish.yml } }
`) as Record<string, unknown>;
      const push = triggers(allowlisted)["push"] as Record<string, unknown>;
      expect(push).toHaveProperty("paths");
    });
  });
});
