import { z } from "zod";

/** Max stored tag length (chars). Bounds row size (M14 risk #2 / EC-3). */
export const TAG_MAX_LENGTH = 64;

/**
 * Trace tags response DTO (M14). `.strict()` so Drizzle columns never leak (M3
 * risk #2). Tags are free-form, case-preserving strings attached to a trace_id.
 */
export const traceTagsResponseSchema = z
  .object({ tags: z.array(z.string()) })
  .strict();

export type TraceTagsResponse = z.infer<typeof traceTagsResponseSchema>;

/**
 * Normalize a raw tag for storage (M14 D4): trim whitespace, preserve case
 * (so "Bug" ≠ "bug" — lowercasing would silently merge distinct labels), and
 * reject empty-after-trim or > {@link TAG_MAX_LENGTH} chars. Returns the clean
 * tag, or `null` when invalid (the route turns null into a 400).
 */
export function normalizeTag(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > TAG_MAX_LENGTH) return null;
  return trimmed;
}
