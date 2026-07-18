/**
 * `LensReadTransport` — the shared HTTP transport base of `@usetheo/lens-sdk`'s read client (M103,
 * split out in M117 to keep `client.ts` under the file-size budget).
 *
 * A thin wrapper over the platform-native `fetch` (parsimony: no HTTP dependency). It owns the
 * constructor, the edge-safe URL composition (the #49 basePath swap), the bounded exp-backoff retry
 * transport (`send`/`request`), and the typed error mapping. `LensReadClient` extends it and adds one
 * public method per route — the transport internals are `protected` so only the subclass reaches them.
 *
 * Auth is a `theo_live_*` key sent as `Authorization: Bearer <key>`; the per-tenant key resolves the
 * workspace at the edge, so the client NEVER sends a workspace parameter (theo-data invariant 2/3).
 *
 * Failures surface as a typed {@link LensApiError} (M104); transient ones (408/429/5xx/network/timeout)
 * are retried with bounded exp-backoff honoring `Retry-After`, while a fatal 4xx fails fast. A request
 * timeout is enforced via `AbortController`.
 */
import { errorFromReject, errorFromResponse, invalidBodyError } from "./errors.js";

export interface LensReadClientOptions {
  /** Engine base URL, e.g. `https://api.usetheo.dev` (a trailing slash is tolerated). */
  baseUrl: string;
  /** A `theo_live_*` per-tenant key. Sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /**
   * The API version root the routes live under (default `/v1` — talking to the engine directly).
   * A customer whose `theo_live_*` key reaches the capability through the **unified edge** sets this to
   * the capability prefix (e.g. `/v1/lens`); the edge rewrites `/v1/lens/*` → `/v1/*` upstream. The SDK
   * swaps the `/v1` root of every route for this value (see #49).
   */
  basePath?: string;
  /** Injected transport (defaults to `globalThis.fetch`) — the seam unit tests drive. */
  fetch?: typeof fetch;
  /** Max retry attempts for a transient failure (default 2 → up to 3 total tries). */
  maxRetries?: number;
  /** Per-request timeout in ms before the socket is aborted (default 30_000). */
  timeoutMs?: number;
  /** Injectable backoff sleep (default real `setTimeout`) — the seam that keeps tests deterministic. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source in [0,1) (default `Math.random`) — deterministic backoff in tests. */
  random?: () => number;
}

/** A query value map; `undefined` entries are dropped, everything else is stringified. */
export type Query = Record<string, string | number | undefined>;

const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 20_000;
const JITTER = 0.2; // ±20% symmetric

/** Transient statuses worth another attempt (GET is idempotent → safe to retry). */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Parse a `Retry-After` header (seconds or HTTP-date) into ms, or undefined when absent/garbage. */
function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (raw === null) return undefined;
  if (/^\d+$/.test(raw.trim())) return Number(raw.trim()) * 1000;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

export class LensReadTransport {
  private readonly baseUrl: string;
  private readonly basePath: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: LensReadClientOptions) {
    if (!options.baseUrl) throw new Error("LensReadClient: baseUrl is required");
    if (!options.apiKey) throw new Error("LensReadClient: apiKey is required");
    // Strip trailing slashes so a base path in baseUrl is preserved when the route path is appended.
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    // Fail-fast at construction (fail-clear, error-handling.md) rather than a raw TypeError from the
    // URL parser on the first request when baseUrl is relative / has no scheme.
    try {
      new URL(this.baseUrl);
    } catch {
      throw new Error(`LensReadClient: baseUrl is not an absolute URL: ${options.baseUrl}`);
    }
    // The version root every route hangs off (default /v1). Must be absolute (start with `/`); a
    // trailing slash is stripped so `${basePath}${rest}` never doubles.
    this.basePath = (options.basePath ?? "/v1").replace(/\/+$/, "");
    if (!this.basePath.startsWith("/")) {
      throw new Error(`LensReadClient: basePath must start with "/": ${options.basePath}`);
    }
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new Error("LensReadClient: no fetch implementation (pass options.fetch)");
    }
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  private buildUrl(path: string, query?: Query): string {
    // Every method's `path` is engine-relative (`/v1/...`); swap the `/v1` root for `basePath` so an
    // edge consumer (basePath `/v1/lens`) composes `/v1/lens/...` (the edge rewrites it back to `/v1/...`).
    // Default basePath `/v1` makes this a no-op (direct-to-engine). Closes #49.
    const routed = this.basePath === "/v1" ? path : path.replace(/^\/v1(?=\/|$)/, this.basePath);
    const url = new URL(`${this.baseUrl}${routed}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /** Delay before the next retry: honor `Retry-After` (capped) else exp-backoff + ±20% jitter. */
  private backoffMs(attempt: number, res?: Response): number {
    const advised = res ? retryAfterMs(res) : undefined;
    if (advised !== undefined) return Math.min(advised, RETRY_CAP_MS);
    const base = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
    const jitter = 1 - JITTER + this.random() * (2 * JITTER); // [0.8, 1.2)
    return Math.min(Math.round(base * jitter), RETRY_CAP_MS);
  }

  /** One `fetch` with an `AbortController` timeout; a fired abort rejects (→ mapped to TIMEOUT). */
  private async fetchOnce(method: string, url: string, body?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      accept: "application/json",
    };
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    try {
      return await this.fetchImpl(url, init);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Parse a 2xx body; a 204 / empty body resolves to `undefined` (void deletes), never a parse crash. */
  private async parseBody<T>(res: Response, method: string, path: string): Promise<T> {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw invalidBodyError(res.status, method, path);
    }
  }

  /**
   * The shared transport seam for every method. Retries a transient failure with bounded backoff.
   * A server-signaled transient (408/429/5xx) is retried for ALL methods; `retryNetwork` additionally
   * gates whether a NETWORK reject / timeout abort is retried — GET + idempotent writes pass `true`, a
   * non-idempotent write (e.g. a synthetic dataset item) passes `false` so an ambiguous timeout is
   * never silently re-applied.
   */
  protected async send<T>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown; retryNetwork: boolean },
  ): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchOnce(method, url, opts.body);
      } catch (err) {
        if (opts.retryNetwork && attempt < this.maxRetries) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw errorFromReject(err, method, path);
      }
      if (res.ok) return this.parseBody<T>(res, method, path);
      if (isRetryableStatus(res.status) && attempt < this.maxRetries) {
        await this.sleep(this.backoffMs(attempt, res));
        continue;
      }
      throw await errorFromResponse(res, method, path);
    }
  }

  /** A GET (idempotent → network retries enabled). */
  protected request<T>(path: string, query?: Query): Promise<T> {
    return this.send<T>("GET", path, { retryNetwork: true, ...(query ? { query } : {}) });
  }
}
