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
 * M103 is the happy-path core: `request()` throws a plain `Error` on a non-2xx (naming status + path).
 * M104 replaces that seam with a typed `LensApiError` + a resilient (retry/backoff/timeout) transport.
 */
import type {
  CostByPeriodOptions,
  CostByPeriodResponse,
  Dataset,
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
}

/** A query value map; `undefined` entries are dropped, everything else is stringified. */
type Query = Record<string, string | number | undefined>;

export class LensReadClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

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

  private async request<T>(path: string, query?: Query): Promise<T> {
    const res = await this.fetchImpl(this.buildUrl(path, query), {
      method: "GET",
      headers: { authorization: `Bearer ${this.apiKey}`, accept: "application/json" },
    });
    if (!res.ok) {
      // M103 minimal error — typed LensApiError + retry arrive in M104.
      throw new Error(`GET ${path} failed: ${res.status}`);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new Error(`GET ${path}: invalid JSON response body`);
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

  /** `GET /v1/datasets` — the workspace's datasets. */
  listDatasets(): Promise<Dataset[]> {
    return this.request<Dataset[]>("/v1/datasets");
  }
}
