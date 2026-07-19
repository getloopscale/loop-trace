import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type SpanRepository } from "@usetheo/lens-core";
import { createSpanRepository, migrateLatest } from "@usetheo/lens-core/infra";
import { createApp } from "@usetheo/lens-api";
import type pg from "pg";

import { LensReadClient } from "./client.js";
import { LensApiError } from "./errors.js";

/**
 * M109 — the write↔read contract proof. Drives the SDK's WRITE methods against the REAL engine app
 * (`createApp(repo)` + a real repo + a real Postgres from the Testcontainers globalSetup, `app.fetch`
 * injected as the transport) and asserts the mutation is observable — the write-side analogue of the
 * M105 read contract. Independently validates the M108 idempotency behavior and proves each
 * hand-written request body (M107) is accepted by the real engine. Gated on THEOLENS_PG_URI.
 */
const PG_URI = process.env["THEOLENS_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

suite("LensReadClient write↔read contract (M109)", () => {
  let app: ReturnType<typeof createApp>;
  let repo: SpanRepository;
  let pool: pg.Pool;
  let client: LensReadClient;

  beforeAll(async () => {
    const created = createSpanRepository(PG_URI as string);
    repo = created.repo;
    pool = created.pool;
    await migrateLatest(pool);
    app = createApp(repo);
    const engineFetch: typeof fetch = (input, init) =>
      app.fetch(new Request(typeof input === "string" ? input : input.toString(), init));
    client = new LensReadClient({
      baseUrl: "http://engine.local",
      apiKey: "theo_live_contract_test",
      fetch: engineFetch,
    });
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE spans, traces, sessions, datasets, dataset_items, trace_tags, annotations");
    // Seed a trace to be the target of item/annotate/tag writes.
    const span = {
      spanId: "sdk-a1",
      traceId: "sdk-t1",
      name: "chat",
      startTimeUnixNano: "1700000000000000000",
      endTimeUnixNano: "1700000000500000000",
      attributes: { "gen_ai.request.model": "gpt-4" },
    };
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] }),
    });
    expect(res.status).toBe(200);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("dataset lifecycle: create → list → add/remove item → delete → gone", async () => {
    const ds = await client.createDataset({ name: "eval-set" });
    expect(ds.id).toBeTruthy();

    let list = await client.listDatasets();
    expect(list.datasets.some((d) => d.id === ds.id)).toBe(true);

    const withItem = await client.addDatasetItem(ds.id, { traceId: "sdk-t1" });
    expect(withItem.items.some((i) => i.traceId === "sdk-t1")).toBe(true);

    const withoutItem = await client.removeDatasetItem(ds.id, "sdk-t1");
    expect(withoutItem.items.some((i) => i.traceId === "sdk-t1")).toBe(false);

    await client.deleteDataset(ds.id);
    list = await client.listDatasets();
    expect(list.datasets.some((d) => d.id === ds.id)).toBe(false);
  });

  it("createDataset is idempotent (same name → same dataset)", async () => {
    const a = await client.createDataset({ name: "dup" });
    const b = await client.createDataset({ name: "dup" });
    expect(b.id).toBe(a.id);
  });

  it("addDatasetItem accepts a synthetic input/output pair (non-idempotent path)", async () => {
    const ds = await client.createDataset({ name: "synth" });
    const detail = await client.addDatasetItem(ds.id, { input: "prompt", output: "resp" });
    expect(detail.items.length).toBe(1);
  });

  it("annotate → read → delete round-trips", async () => {
    const added = await client.annotateTrace("sdk-t1", { label: "good", note: "nice" });
    expect(added.annotations.length).toBeGreaterThanOrEqual(1);
    const cleared = await client.deleteAnnotations("sdk-t1");
    expect(cleared.annotations.length).toBe(0);
  });

  it("tag → read → untag round-trips", async () => {
    const tagged = await client.tagTrace("sdk-t1", { tag: "urgent" });
    expect(tagged.tags).toContain("urgent");
    const untagged = await client.untagTrace("sdk-t1", "urgent");
    expect(untagged.tags).not.toContain("urgent");
  });

  it("maps a real 404 envelope on a write to a missing dataset", async () => {
    const err = await client
      .addDatasetItem("00000000-0000-0000-0000-000000000000", { traceId: "sdk-t1" })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(LensApiError);
    expect((err as LensApiError).status).toBe(404);
    expect((err as LensApiError).code).toBe("NOT_FOUND");
  });
});
