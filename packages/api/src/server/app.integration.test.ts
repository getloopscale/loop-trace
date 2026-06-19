import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  createSpanRepository,
  migrateLatest,
  type SpanRepository,
} from "@usetheo/lens-core";
import type pg from "pg";

import { createApp } from "./app.js";
import { spansIngested } from "./metrics.js";

const PG_URI = process.env["THEOLENS_PG_URI"];
const suite = PG_URI ? describe : describe.skip;

function tracesEnvelope(span: Record<string, unknown>): string {
  return JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] });
}

const rawSpan = {
  spanId: "api-a1",
  traceId: "api-t1",
  name: "op",
  startTimeUnixNano: "1700000000000000000",
  endTimeUnixNano: "1700000000100000000",
};

suite("createApp (integration)", () => {
  let app: ReturnType<typeof createApp>;
  let repo: SpanRepository;
  let pool: pg.Pool;

  beforeAll(async () => {
    const created = createSpanRepository(PG_URI as string);
    repo = created.repo;
    pool = created.pool;
    await migrateLatest(pool);
    app = createApp(repo);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE spans");
    spansIngested.reset();
  });

  afterAll(async () => {
    await pool.end();
  });

  function post(body: BodyInit, contentType = "application/json"): Promise<Response> {
    return app.request("/v1/traces", {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    });
  }

  it("post_traces_rejects_non_json_content_type_415", async () => {
    const res = await post(tracesEnvelope(rawSpan), "application/x-protobuf");
    expect(res.status).toBe(415);
  });

  it("post_traces_persists_span_and_increments_metric", async () => {
    const res = await post(tracesEnvelope(rawSpan));
    expect(res.status).toBe(200);
    expect(spansIngested.value).toBe(1);
    const got = await repo.getBySpanId("api-a1");
    expect(got).toMatchObject({ spanId: "api-a1", traceId: "api-t1" });
  });

  it("post_traces_empty_envelope_returns_200_empty", async () => {
    const res = await post(JSON.stringify({ resourceSpans: [] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect(spansIngested.value).toBe(0);
  });

  it("post_traces_malformed_json_returns_400", async () => {
    const res = await post("{ not json");
    expect(res.status).toBe(400);
  });

  it("get_span_returns_persisted_span", async () => {
    await post(tracesEnvelope(rawSpan));
    const res = await app.request("/v1/spans/api-a1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ spanId: "api-a1" });
  });

  it("get_unknown_span_returns_404", async () => {
    const res = await app.request("/v1/spans/does-not-exist");
    expect(res.status).toBe(404);
  });
});
