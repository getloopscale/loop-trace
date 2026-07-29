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

describe("M137 — publication gates", () => {
  describe("the gates are callable (T1.1)", () => {
    it.each(["ci.yml", "integration.yml"])(
      "%s declares workflow_call, without which it cannot be a gate",
      (file) => {
        expect(triggers(workflow(file))).toHaveProperty("workflow_call");
      },
    );

    it("ci.yml keeps its PR + push triggers — the gate is additive, not a replacement", () => {
      const on = triggers(workflow("ci.yml"));
      expect(on).toHaveProperty("pull_request");
      expect(on).toHaveProperty("push");
    });
  });

  describe("the image waits for the suite (T1.2)", () => {
    it("image declares needs on both gates and the release guard", () => {
      const needs = jobs(workflow("publish.yml"))["image"]?.["needs"];
      expect(needs, "publish.yml image job must declare needs:").toBeDefined();
      const list = Array.isArray(needs) ? needs : [needs];
      expect(list).toEqual(expect.arrayContaining(["gate-ci", "gate-contract", "guard-release-on-main"]));
    });

    it("the gate jobs call the local workflows, not a copy of their steps", () => {
      const j = jobs(workflow("publish.yml"));
      expect(j["gate-ci"]?.["uses"]).toBe("./.github/workflows/ci.yml");
      expect(j["gate-contract"]?.["uses"]).toBe("./.github/workflows/integration.yml");
    });

    /**
     * R2 from the plan: `workflow_call` widens the surface — a secret declared on a gate that does
     * not need it is handed to every future caller. `ci` needs none.
     */
    it("gate-ci is passed no secrets", () => {
      expect(jobs(workflow("publish.yml"))["gate-ci"]).not.toHaveProperty("secrets");
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

  describe("docs-only work does not consume the pipeline (T2.2 / ADR D2)", () => {
    it("ci.yml filters by a positive paths allowlist", () => {
      const push = triggers(workflow("ci.yml"))["push"] as Record<string, unknown>;
      expect(push?.["paths"], "ci.yml must declare an allowlist").toBeDefined();
      expect(push["paths"]).toEqual(
        expect.arrayContaining(["packages/**", ".github/workflows/**"]),
      );
    });

    /**
     * ADR D2. A denylist fails SILENTLY — a new top-level directory is included by default and burns
     * the queue until someone reads the bill. An allowlist fails LOUDLY. Measured across five peers:
     * `paths:` 45, `paths-ignore:` 3.
     */
    it("ci.yml does NOT use paths-ignore — the denylist is the weaker of the two", () => {
      const push = triggers(workflow("ci.yml"))["push"] as Record<string, unknown>;
      expect(push).not.toHaveProperty("paths-ignore");
    });

    it("publish.yml carries no path filter — a tag build always ships code", () => {
      const push = triggers(workflow("publish.yml"))["push"] as Record<string, unknown>;
      expect(push).not.toHaveProperty("paths");
      expect(push).not.toHaveProperty("paths-ignore");
    });
  });

  /**
   * NEGATIVE CASE (`rules/testing.md` § 4.1). Everything above proves the gate is PRESENT. This
   * proves the assertions can still FAIL — a test that only ever sees a correct file cannot tell you
   * it would notice a wrong one, and a gate-pinning test that cannot detect removal is theatre.
   */
  describe("the pin can actually detect removal", () => {
    it("a publish.yml with needs: stripped fails the image assertion", () => {
      const stripped = parse(`
name: Publish
on: { push: { branches: [develop] } }
jobs:
  image:
    uses: ./.github/workflows/build-publish.yml
`) as Record<string, unknown>;
      const needs = jobs(stripped)["image"]?.["needs"];
      expect(needs).toBeUndefined();
    });

    it("a ci.yml using paths-ignore fails the allowlist assertion", () => {
      const denylisted = parse(`
name: CI
on: { push: { branches: [develop], paths-ignore: ["**.md"] } }
jobs: { build: { runs-on: ubuntu-latest } }
`) as Record<string, unknown>;
      const push = triggers(denylisted)["push"] as Record<string, unknown>;
      expect(push).toHaveProperty("paths-ignore");
      expect(push["paths"]).toBeUndefined();
    });
  });
});
