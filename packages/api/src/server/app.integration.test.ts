import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  type SpanRepository,
} from "@looptrace/core";
import { createSpanRepository, migrateLatest } from "@looptrace/core/infra";
import type pg from "pg";

import { createApp } from "./app.js";
import { spansIngested, tracesIngested } from "./metrics.js";
import { encodeOtlpProtobuf } from "../otlp/__fixtures__/otlp-protobuf.js";

const PG_URI = process.env["LOOPTRACE_PG_URI"];
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
    await pool.query("TRUNCATE spans, traces, sessions");
    spansIngested.reset();
    tracesIngested.reset();
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

  it("post_traces_rejects_unsupported_content_type_415", async () => {
    // M1 accepts json + protobuf; csv is unsupported → 415.
    const res = await post(tracesEnvelope(rawSpan), "text/csv");
    expect(res.status).toBe(415);
  });

  it("post_traces_persists_span_and_increments_metric", async () => {
    const res = await post(tracesEnvelope(rawSpan));
    expect(res.status).toBe(200);
    expect(spansIngested.value).toBe(1);
    expect(tracesIngested.value).toBe(1); // metric proof at integration level (F-wiring-1)
    const got = await repo.getBySpanId("api-a1");
    expect(got).toMatchObject({ spanId: "api-a1", traceId: "api-t1" });
  });

  it("post_protobuf_real_db_roundtrip_increments_tracesIngested", async () => {
    const bytes = encodeOtlpProtobuf({
      resourceSpans: [
        { scopeSpans: [{ spans: [{ name: "op", traceId: Buffer.from([0x0a, 0x0b]), spanId: Buffer.from([0x0c, 0x0d]), startTimeUnixNano: "1", endTimeUnixNano: "2" }] }] },
      ],
    });
    const res = await app.request("/v1/traces", {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: bytes,
    });
    expect(res.status).toBe(200);
    expect(tracesIngested.value).toBe(1);
    expect(await repo.getBySpanId("0c0d")).not.toBeNull(); // hex-normalized id persisted
  });

  it("post_traces_empty_envelope_returns_200_empty", async () => {
    const res = await post(JSON.stringify({ resourceSpans: [] }));
    expect(res.status).toBe(200);
    // M93 partial-success contract: full success carries an empty partial_success
    // (`{ partialSuccess: {} }`), which per OTLP is equivalent to "not present".
    expect(await res.json()).toEqual({ partialSuccess: {} });
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
