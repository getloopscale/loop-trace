import { describe, it, expect } from "vitest";
import { encodeOtlpProtobuf } from "../../packages/api/src/otlp/__fixtures__/otlp-protobuf.js";

const BASE = process.env["LOOPTRACE_E2E_BASE"] ?? "http://localhost:44318";

// Buffer ids → the API normalizes to lowercase hex; compute the expected hex.
const traceIdBytes = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
const rootBytes = Buffer.from([0x01]);
const child1Bytes = Buffer.from([0x02]);
const child2Bytes = Buffer.from([0x03]);
const traceHex = traceIdBytes.toString("hex");

function span(spanId: Buffer, parent?: Buffer) {
  return {
    traceId: traceIdBytes,
    spanId,
    ...(parent ? { parentSpanId: parent } : {}),
    name: "op",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000000250000000",
  };
}

describe("OTLP protobuf trace-tree round-trip (e2e)", () => {
  it("protobuf_trace_tree_roundtrip_from_clean_compose", async () => {
    const bytes = encodeOtlpProtobuf({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                span(rootBytes),
                span(child1Bytes, rootBytes),
                span(child2Bytes, rootBytes),
              ],
            },
          ],
        },
      ],
    });

    const post = await fetch(`${BASE}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf" },
      body: bytes,
    });
    expect(post.status).toBe(200);

    const get = await fetch(`${BASE}/v1/traces/${traceHex}`);
    expect(get.status).toBe(200);
    const tree = (await get.json()) as {
      spanId: string;
      children: { spanId: string }[];
    };
    expect(tree.spanId).toBe(rootBytes.toString("hex"));
    expect(tree.children.map((c) => c.spanId).sort()).toEqual(
      [child1Bytes.toString("hex"), child2Bytes.toString("hex")].sort(),
    );
  });
});
