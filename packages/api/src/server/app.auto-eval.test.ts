import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Span, SpanRepository } from "@usetheo/lens-core";

import { createApp } from "./app.js";
import { autoEvalEnqueueFailures } from "./metrics.js";

/**
 * M134 T5.1 — the ingest hook (ADR D5).
 *
 * The whole point of the milestone is that scoring never touches the ingest
 * path. These tests assert the OUTER property neither reference project tests:
 * that an ingest still succeeds when the eval-side enqueue throws. Both
 * references only assert the weaker inner form (a single dep failure does not
 * itself throw).
 */

const ENVELOPE = {
  resourceSpans: [
    {
      scopeSpans: [
        {
          spans: [
            {
              traceId: "aa",
              spanId: "bb",
              name: "chat",
              startTimeUnixNano: "1700000000000000000",
              endTimeUnixNano: "1700000000100000000",
            },
          ],
        },
      ],
    },
  ],
};

function stubRepo(): SpanRepository {
  return {
    save: vi.fn(async () => {}),
    listTraces: vi.fn(async () => []),
  } as unknown as SpanRepository;
}

const post = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request("http://x/v1/traces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("auto-eval ingest hook (M134 T5.1)", () => {
  beforeEach(() => {
    autoEvalEnqueueFailures.reset();
  });

  it("test_ingest_succeeds_when_enqueue_throws", async () => {
    // The assertion that encodes ADR D5. A rejecting enqueue must not surface
    // in the response — an eval-side outage cannot become an ingest outage.
    const enqueueAutoEval = vi.fn(async () => {
      throw new Error("queue table unavailable");
    });
    const app = createApp(stubRepo(), undefined, {}, undefined, undefined, undefined, undefined, {
      enqueueAutoEval,
    });

    const res = await post(app, ENVELOPE);

    expect(res.status).toBeLessThan(300);
    // ...and the drop is COUNTED. Swallowing without a signal is blueprint AP-3,
    // where the reference logs, returns, and the eval is lost with nothing to show.
    await vi.waitFor(() => expect(autoEvalEnqueueFailures.value).toBe(1));
  });

  it("test_ingest_does_not_wait_for_the_enqueue", async () => {
    // Fire-and-forget: a slow enqueue must not add latency to the response.
    let release: (() => void) | undefined;
    const enqueueAutoEval = vi.fn(
      () => new Promise<void>((r) => { release = r; }),
    );
    const app = createApp(stubRepo(), undefined, {}, undefined, undefined, undefined, undefined, {
      enqueueAutoEval,
    });

    const res = await post(app, ENVELOPE);

    // The response resolved while the enqueue is still pending.
    expect(res.status).toBeLessThan(300);
    expect(release).toBeDefined();
    release?.();
  });

  it("test_enqueue_receives_the_saved_spans_and_the_workspace", async () => {
    const enqueueAutoEval = vi.fn(async () => {});
    const app = createApp(stubRepo(), undefined, {}, undefined, undefined, undefined, undefined, {
      enqueueAutoEval,
    });

    await post(app, ENVELOPE);

    await vi.waitFor(() => expect(enqueueAutoEval).toHaveBeenCalledTimes(1));
    const [spans, ws] = enqueueAutoEval.mock.calls[0] as unknown as [Span[], string];
    expect(spans.map((s) => s.traceId)).toEqual(["aa"]);
    expect(typeof ws).toBe("string");
  });

  it("test_auto_eval_absent_is_a_no_op_not_an_error", async () => {
    // Auto-eval is opt-in. A deployment that never configures it must ingest
    // exactly as before, with no counter movement.
    const app = createApp(stubRepo());

    const res = await post(app, ENVELOPE);

    expect(res.status).toBeLessThan(300);
    expect(autoEvalEnqueueFailures.value).toBe(0);
  });

  it("test_no_enqueue_when_every_span_was_rejected", async () => {
    // The zero-cost path: nothing was saved, so there is nothing to evaluate.
    const enqueueAutoEval = vi.fn(async () => {});
    const app = createApp(stubRepo(), undefined, {}, undefined, undefined, undefined, undefined, {
      enqueueAutoEval,
    });

    await post(app, { resourceSpans: [{ scopeSpans: [{ spans: [{ traceId: "" }] }] }] });

    expect(enqueueAutoEval).not.toHaveBeenCalled();
  });
});

describe("both ingest paths are hooked (M134 T5.1)", () => {
  it("test_every_repo_save_site_enqueues_auto_eval", () => {
    // theo-lens has TWO ingest write points (OTLP and /v1/runs). Hooking one and
    // missing the other makes a whole route silently never auto-evaluate — a
    // failure with no error and no counter, visible only as "some traces are
    // never scored". This exact mistake happened while writing T5.1: a
    // careless edit put both hooks at the same site. A behavioural test per
    // route would not have caught it; the structural count does.
    const src = readFileSync(
      fileURLToPath(new URL("./app.ts", import.meta.url)),
      "utf8",
    );
    const saveSites = [...src.matchAll(/await repo\.save\(/g)].length;
    const hookSites = [...src.matchAll(/enqueueAutoEval\(ingest, toSave, ws\)/g)].length;

    expect(saveSites).toBe(2);
    expect(hookSites).toBe(saveSites);
  });
});

describe("recursion tripwire (M134 ADR D3)", () => {
  it("test_judge_path_emits_no_spans_into_the_store", () => {
    // ADR D3 skips the anti-recursion guard because theo-lens is in Opik's
    // position: evaluations emit SCORES, not traces, so the self-trigger edge
    // Langfuse guards against does not exist. That is a verified fact, not an
    // assumption — and this test is what keeps it a fact.
    //
    // If judge calls ever start emitting spans into theo-lens (for judge
    // debuggability, which is exactly why the reference traces them), this
    // fails and the recursion requirement surfaces HERE — rather than as an
    // unbounded, self-amplifying judge bill in production, which is silent by
    // construction because the runaway traffic looks like legitimate eval work.
    const judgeSrc = readFileSync(
      fileURLToPath(
        new URL(
          "../../../core/src/domain/evaluation/llm-judge.ts",
          import.meta.url,
        ),
      ),
      "utf8",
    );

    // No repository/store/ingest reachable from the judge module.
    expect(judgeSrc).not.toMatch(/SpanRepository|repo\.save|\/v1\/traces/);
    // Its only imports are the provider chat client and its own types.
    const imports = [...judgeSrc.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(
      ["../provider/chat.js", "./evaluator.js", "zod"].sort(),
    );
  });
});
