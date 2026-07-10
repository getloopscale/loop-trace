import { z } from "zod";

/**
 * M92 — span attribute facet discovery. Two modes over the `spans.attributes` jsonb bag,
 * both workspace-scoped + capped (a recent window + top-N; no inverted index — the suggest
 * control needs a hint, not an exhaustive index):
 *
 * - **keys** (no `key` param): the top distinct attribute keys in the workspace, by frequency.
 * - **values** (`?key=<k>`): the top distinct `attributes ->> k` values for one key, by frequency.
 *
 * The `key` in values-mode is bound as a jsonb path (data, never SQL) — the same injection-safety
 * property as the `attr:` filter clause. Strict DTOs enforce the no-column-leak invariant.
 */

const facetKeySchema = z
  .object({ key: z.string(), count: z.number().int().nonnegative() })
  .strict();

const facetValueSchema = z
  .object({ value: z.string(), count: z.number().int().nonnegative() })
  .strict();

export const spanFacetsResponseSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("keys"), keys: z.array(facetKeySchema) }).strict(),
  z
    .object({
      mode: z.literal("values"),
      key: z.string(),
      values: z.array(facetValueSchema),
    })
    .strict(),
]);

export type SpanFacetsResponse = z.infer<typeof spanFacetsResponseSchema>;
export type SpanAttributeKey = z.infer<typeof facetKeySchema>;
export type SpanAttributeValue = z.infer<typeof facetValueSchema>;
