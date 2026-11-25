/**
 * M124 (D3) — export the single TS source of truth `MAPPER_VECTORS` into a committed,
 * language-neutral `theokit-vectors.json` so the Python (M124) / Go (M125) SDK test suites can
 * pin their serializer against the SAME 18 documented behaviors without a hand-mirrored copy.
 *
 * The JSON is the INPUT batches only — `[{ name, messages, result? }]` — the vitest `assert`
 * closures are dropped (they are TS-only and cannot cross the language boundary). One vector
 * carries a self-referential `args` object (the mapper's circular-degradation behavior); it is
 * NOT representable in JSON, so it is normalized to the marker `"[Circular]"`. That normalization
 * is a serialization concern of THIS projection only — the circular-degrade behavior it stands in
 * for is the TS mapper's, out of scope for a downstream client's serialize-and-POST contract.
 *
 * Run:  pnpm --filter @looptrace/core exec tsx scripts/export-theokit-vectors.ts
 * The committed output is guarded against drift by `theokit-vectors-json.test.ts`.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MAPPER_VECTORS } from "../src/domain/theokit/theokit-vectors.js";

/** The language-neutral projection of one `MapperVector` (assert closures dropped). */
export interface VectorProjection {
  readonly name: string;
  readonly messages: unknown;
  readonly result?: unknown;
}

/**
 * A `JSON.stringify` replacer that survives a self-referential object by emitting `"[Circular]"`
 * instead of throwing. Only circular back-edges are rewritten; every finite value passes through.
 */
function circularSafeReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  };
}

/**
 * Project `MAPPER_VECTORS` into the committed array shape, normalized through one JSON round-trip
 * (so circular back-edges become `"[Circular]"` and the result is guaranteed valid JSON data).
 * Pure — no I/O — so the drift-guard test can call it directly.
 */
export function projectVectors(): readonly VectorProjection[] {
  const projected = MAPPER_VECTORS.map((v) => ({
    name: v.name,
    messages: v.input.messages,
    ...(v.input.result !== undefined ? { result: v.input.result } : {}),
  }));
  return JSON.parse(JSON.stringify(projected, circularSafeReplacer())) as VectorProjection[];
}

/** The exact committed file bytes: pretty-printed with a trailing newline. */
export function renderVectorsJson(): string {
  return `${JSON.stringify(projectVectors(), null, 2)}\n`;
}

/** Absolute path of the committed artifact. */
export const OUTPUT_PATH = fileURLToPath(
  new URL("../src/domain/theokit/theokit-vectors.json", import.meta.url),
);

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(OUTPUT_PATH, renderVectorsJson());
  console.log(`Wrote ${OUTPUT_PATH} (${projectVectors().length} vectors)`);
}
