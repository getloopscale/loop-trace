/**
 * M118 (D1) — pre-parse body-size caps for the advanced write routes. Each buffering `POST`/`PUT` that
 * calls `c.req.json()` gets the SAME `bodyLimit({ maxSize, onError → 413 })` wrapper the CORE ingest
 * surface uses (`app.ts` `/v1/traces` + `/v1/runs`), sourcing `maxSize` from each route's existing
 * post-parse cap (D1: the cap only moves earlier, never shrinks). Cap-less small routes get a modest
 * 64 KiB ceiling (UQ1). One shared `bodyLimit413` factory keeps the exact 413 envelope in one place
 * (DRY) so every route sheds an oversized payload at the stream, never buffering it into memory.
 */
import type { MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { errorBody } from "@usetheo/lens-core";

/**
 * Per-route pre-parse ceilings (bytes). The value reuses each route's existing post-parse cap where one
 * exists; cap-less routes get {@link DEFAULT_ADVANCED_MAX_BYTES}. Named so the 413 test can parameterize
 * over the exact same table the middleware reads (single source of truth).
 */
export const DEFAULT_ADVANCED_MAX_BYTES = 64 * 1024; // 64 KiB — cap-less small routes (UQ1)

/** Replay reuses its post-parse 256 KiB message-content cap (`replay.ts` MAX_TOTAL_BYTES). */
export const REPLAY_MAX_BYTES = 256 * 1024;
/** Experiment-run body carries a prompt override bounded to 8 KiB post-parse (`experiment.ts` MAX_PROMPT_LEN). */
export const EXPERIMENT_MAX_BYTES = 64 * 1024;
/** Evaluator/guard config bodies (predicate / judge prompt) — a modest 64 KiB ceiling. */
export const EVALUATOR_MAX_BYTES = 64 * 1024;
/**
 * Dataset item bodies: the route accepts a synthetic item with `input` up to 256K chars AND `output`
 * up to 256K chars post-parse (`dataset-routes.ts` MAX). The PRE-parse byte cap must EXCEED that
 * combined character budget so a legitimate max-size item is never shed with a 413 (D1: the cap only
 * moves EARLIER, it never SHRINKS the accepted payload). 2×256K chars at up to 3 UTF-8 bytes/char + the
 * JSON envelope ≈ 1.5 MiB worst case → a 2 MiB ceiling clears any post-parse-valid body while still
 * bounding memory. (A 256 KiB pre-parse cap wrongly 413'd a 256K-char input — M118 review MEDIUM.)
 */
export const DATASET_ITEM_MAX_BYTES = 2 * 1024 * 1024;
/** Dataset create/rename bodies carry only a short name (120 chars) — the modest default. */
export const DATASET_NAME_MAX_BYTES = 64 * 1024;

/**
 * The shared pre-parse guard: bound the RAW body BEFORE it is buffered and return a typed
 * `413 PAYLOAD_TOO_LARGE` on overflow — the exact envelope the CORE ingest routes emit
 * (`app.ts` `/v1/traces` onError). Mounted as the FIRST middleware on a route so an oversized
 * body is shed before the scope guard or the handler run.
 */
export function bodyLimit413(maxSize: number, message = "request body exceeds the size limit"): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    onError: (c) => c.json(errorBody("PAYLOAD_TOO_LARGE", message), 413),
  });
}
