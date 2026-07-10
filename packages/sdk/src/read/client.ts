/**
 * `LensReadClient` — the typed read surface of `@usetheo/lens-sdk` (M103).
 *
 * A thin wrapper over the platform-native `fetch` (parsimony: no HTTP dependency) that exposes one
 * typed method per named-component read route. Responses are typed from the generated OpenAPI
 * (`../__generated__/openapi.ts`); requests map a small typed options object to the snake_case query.
 *
 * Auth is a `theo_live_*` key sent as `Authorization: Bearer <key>`; the per-tenant key resolves the
 * workspace at the edge, so the client NEVER sends a workspace parameter (theo-data invariant 2/3).
 *
 * Failures surface as a typed {@link LensApiError} (M104); transient ones (408/429/5xx/network/timeout)
 * are retried with bounded exp-backoff honoring `Retry-After`, while a fatal 4xx fails fast. A request
 * timeout is enforced via `AbortController`.
 */
import { errorFromReject, errorFromResponse, invalidBodyError } from "./errors.js";
import type {
  CostByPeriodOptions,
  CostByPeriodResponse,
  DatasetsResponse,
  ListSessionsOptions,
  ListTracesOptions,
  ObservabilityOptions,
  ObservabilityResponse,
  SessionListResponse,
  Span,
  ToolStatsResponse,
  TraceListResponse,
} from "./types.js";

export interface LensReadClientOptions {
  /** Engine base URL, e.g. `https://api.usetheo.dev` (a trailing slash is tolerated). */
  baseUrl: string;
  /** A `theo_live_*` per-tenant key. Sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
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
type Query = Record<string, string | number | undefined>;

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

export class LensReadClient {
  private readonly baseUrl: string;
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
    const url = new URL(`${this.baseUrl}${path}`);
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
  private async fetchOnce(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json" },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async request<T>(path: string, query?: Query): Promise<T> {
    const url = this.buildUrl(path, query);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchOnce(url);
      } catch (err) {
        // Network reject / timeout abort — retry while attempts remain, else surface it typed.
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw errorFromReject(err, "GET", path);
      }
      if (res.ok) {
        try {
          return (await res.json()) as T;
        } catch {
          throw invalidBodyError(res.status, "GET", path);
        }
      }
      if (isRetryableStatus(res.status) && attempt < this.maxRetries) {
        await this.sleep(this.backoffMs(attempt, res));
        continue;
      }
      throw await errorFromResponse(res, "GET", path);
    }
  }

  /** `GET /v1/traces` — paginated, filterable trace list. */
  listTraces(options: ListTracesOptions = {}): Promise<TraceListResponse> {
    return this.request<TraceListResponse>("/v1/traces", {
      status: options.status,
      model: options.model,
      limit: options.limit,
      offset: options.offset,
      session_id: options.sessionId,
    });
  }

  /** `GET /v1/spans/{spanId}` — a single enriched span. */
  getSpan(spanId: string): Promise<Span> {
    return this.request<Span>(`/v1/spans/${encodeURIComponent(spanId)}`);
  }

  /** `GET /v1/metrics/observability` — observability time-series + rollups. */
  observability(options: ObservabilityOptions = {}): Promise<ObservabilityResponse> {
    return this.request<ObservabilityResponse>("/v1/metrics/observability", {
      range: options.range,
    });
  }

  /** `GET /v1/sessions` — paginated session list. */
  listSessions(options: ListSessionsOptions = {}): Promise<SessionListResponse> {
    return this.request<SessionListResponse>("/v1/sessions", {
      limit: options.limit,
      offset: options.offset,
    });
  }

  /** `GET /v1/analytics/cost` — cost broken down by period. */
  costByPeriod(options: CostByPeriodOptions = {}): Promise<CostByPeriodResponse> {
    return this.request<CostByPeriodResponse>("/v1/analytics/cost", { period: options.period });
  }

  /** `GET /v1/analytics/tools` — tool-call usage stats. */
  toolStats(): Promise<ToolStatsResponse> {
    return this.request<ToolStatsResponse>("/v1/analytics/tools");
  }

  /** `GET /v1/datasets` — the workspace's datasets, wrapped as `{ datasets: [...] }`. */
  listDatasets(): Promise<DatasetsResponse> {
    return this.request<DatasetsResponse>("/v1/datasets");
  }
}
