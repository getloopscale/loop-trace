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
  AddDatasetItemBody,
  AnnotateBody,
  AnnotationsResponse,
  Capabilities,
  CostByPeriodOptions,
  CostByPeriodResponse,
  CreateDatasetBody,
  Dataset,
  DatasetDetail,
  DatasetsResponse,
  ListSessionsOptions,
  ListTracesOptions,
  ObservabilityOptions,
  ObservabilityResponse,
  SessionListResponse,
  Span,
  TagBody,
  ToolStatsResponse,
  TraceListResponse,
  TraceTagsResponse,
  UpdateDatasetBody,
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
   * The shared transport seam for every method. Retries a transient failure with bounded backoff;
   * `retryNetwork` gates whether a network reject / timeout abort is retried — GET + idempotent
   * writes pass `true`, a non-idempotent write passes `false` so an ambiguous timeout is never
   * silently re-applied (M107 ADR-3; M108 tunes the per-verb flag).
   */
  private async send<T>(
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
  private request<T>(path: string, query?: Query): Promise<T> {
    return this.send<T>("GET", path, { retryNetwork: true, ...(query ? { query } : {}) });
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

  /** `GET /v1` — service discovery: identity, version, and the `/openapi.json` pointer. */
  capabilities(): Promise<Capabilities> {
    return this.request<Capabilities>("/v1");
  }

  // ─── Write surface (M107) — curate datasets + annotate/tag traces. ───
  // Writes pass `retryNetwork: false` (M107 conservative default — a non-idempotent create is never
  // re-applied on an ambiguous timeout); M108 loosens this for provably-idempotent verbs.

  /** `POST /v1/datasets` — create (or idempotently get) a dataset by name. */
  createDataset(body: CreateDatasetBody): Promise<Dataset> {
    return this.send<Dataset>("POST", "/v1/datasets", { body, retryNetwork: false });
  }

  /** `PUT /v1/datasets/{id}` — rename a dataset (409 `NAME_CONFLICT` if the name is taken). */
  updateDataset(datasetId: string, body: UpdateDatasetBody): Promise<Dataset> {
    return this.send<Dataset>("PUT", `/v1/datasets/${encodeURIComponent(datasetId)}`, {
      body,
      retryNetwork: false,
    });
  }

  /** `DELETE /v1/datasets/{id}` — delete a dataset (204 → void). */
  deleteDataset(datasetId: string): Promise<void> {
    return this.send<void>("DELETE", `/v1/datasets/${encodeURIComponent(datasetId)}`, {
      retryNetwork: false,
    });
  }

  /** `POST /v1/datasets/{id}/items` — add a captured trace and/or a synthetic input/output pair. */
  addDatasetItem(datasetId: string, body: AddDatasetItemBody): Promise<DatasetDetail> {
    return this.send<DatasetDetail>("POST", `/v1/datasets/${encodeURIComponent(datasetId)}/items`, {
      body,
      retryNetwork: false,
    });
  }

  /** `DELETE /v1/datasets/{id}/items/{traceId}` — remove an item; returns the updated detail. */
  removeDatasetItem(datasetId: string, traceId: string): Promise<DatasetDetail> {
    return this.send<DatasetDetail>(
      "DELETE",
      `/v1/datasets/${encodeURIComponent(datasetId)}/items/${encodeURIComponent(traceId)}`,
      { retryNetwork: false },
    );
  }

  /** `POST /v1/traces/{traceId}/annotations` — add an annotation (label and/or note). */
  annotateTrace(traceId: string, body: AnnotateBody): Promise<AnnotationsResponse> {
    return this.send<AnnotationsResponse>(
      "POST",
      `/v1/traces/${encodeURIComponent(traceId)}/annotations`,
      { body, retryNetwork: false },
    );
  }

  /** `DELETE /v1/traces/{traceId}/annotations` — clear a trace's annotations. */
  deleteAnnotations(traceId: string): Promise<AnnotationsResponse> {
    return this.send<AnnotationsResponse>(
      "DELETE",
      `/v1/traces/${encodeURIComponent(traceId)}/annotations`,
      { retryNetwork: false },
    );
  }

  /** `POST /v1/traces/{traceId}/tags` — add a tag to a trace. */
  tagTrace(traceId: string, body: TagBody): Promise<TraceTagsResponse> {
    return this.send<TraceTagsResponse>("POST", `/v1/traces/${encodeURIComponent(traceId)}/tags`, {
      body,
      retryNetwork: false,
    });
  }

  /** `DELETE /v1/traces/{traceId}/tags?tag=` — remove a tag from a trace. */
  untagTrace(traceId: string, tag: string): Promise<TraceTagsResponse> {
    return this.send<TraceTagsResponse>(
      "DELETE",
      `/v1/traces/${encodeURIComponent(traceId)}/tags`,
      { query: { tag }, retryNetwork: false },
    );
  }
}
