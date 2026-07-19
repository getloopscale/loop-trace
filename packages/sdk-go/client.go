package theolens

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

// DefaultBasePath is the direct data-API path root. Consumers behind the unified edge use
// WithBasePath("/v1/lens") — the per-tenant edge (the #49 fix).
const DefaultBasePath = "/v1"

// config is the immutable per-Client (and per-call) configuration resolved from options.
type config struct {
	baseURL     string
	apiKey      string
	basePath    string
	httpClient  *http.Client
	startTimeMs *int64
}

// Option configures a Client (at New) or a single RecordRun call (per-call overrides win).
type Option func(*config)

// WithBaseURL sets the engine or edge origin, e.g. https://app.usetheo.dev (no trailing slash).
func WithBaseURL(baseURL string) Option { return func(c *config) { c.baseURL = baseURL } }

// WithAPIKey sets the theo_live_* per-tenant key, sent as Authorization: Bearer (observability:write).
func WithAPIKey(apiKey string) Option { return func(c *config) { c.apiKey = apiKey } }

// WithBasePath sets the path root: "/v1" (direct) or "/v1/lens" (unified edge).
func WithBasePath(basePath string) Option { return func(c *config) { c.basePath = basePath } }

// WithHTTPClient injects a custom *http.Client (the transport seam tests use to capture requests).
func WithHTTPClient(hc *http.Client) Option { return func(c *config) { c.httpClient = hc } }

// WithStartTimeMs sets the optional base epoch-ms forwarded to the engine mapper (deterministic tests).
func WithStartTimeMs(ms int64) Option { return func(c *config) { v := ms; c.startTimeMs = &v } }

// Client is a thin, concurrency-safe ingest client. It holds only immutable config plus a shared
// *http.Client (itself safe for concurrent use); RecordRun builds a fresh request per call and never
// mutates the Client, so one Client is safely shared across goroutines.
type Client struct {
	cfg config
}

// New constructs a Client from the given options. Defaults: basePath "/v1", the stdlib
// http.DefaultClient. baseURL and apiKey are required by RecordRun.
func New(opts ...Option) *Client {
	cfg := config{basePath: DefaultBasePath, httpClient: http.DefaultClient}
	for _, o := range opts {
		o(&cfg)
	}
	return &Client{cfg: cfg}
}

// RunOutcome is the parsed 200 {partialSuccess} result. RejectedSpans is 0 on full success; a
// positive count (with ErrorMessage) means the engine accepted the run but dropped some spans —
// surfaced, never raised.
type RunOutcome struct {
	RejectedSpans int
	ErrorMessage  string
}

// OK reports whether every span was accepted.
func (o *RunOutcome) OK() bool { return o.RejectedSpans == 0 }

// runsBody is the exact wire shape POSTed to /v1/runs: {messages, result?, startTimeMs?}.
type runsBody struct {
	Messages    []SDKMessage `json:"messages"`
	Result      *RunResult   `json:"result,omitempty"`
	StartTimeMs *int64       `json:"startTimeMs,omitempty"`
}

// RecordRun marshals {messages, result?, startTimeMs?} and POSTs it to ${baseURL}${basePath}/runs
// with Authorization: Bearer and Content-Type: application/json. The engine maps the batch to spans;
// this client encodes NO OTLP. Per-call opts extend/override the Client's config.
//
// Returns the parsed *RunOutcome on any 2xx (a populated partialSuccess is a non-error signal). A
// non-2xx becomes a *TheoLensError (Status + parsed code/message; 429 surfaces Retry-After). A
// network failure is wrapped errors.Is-friendly (ErrTransport). ctx cancellation aborts the in-flight
// POST. A run POST is non-idempotent and is NEVER retried on an ambiguous timeout (M108).
func (c *Client) RecordRun(ctx context.Context, messages []SDKMessage, result *RunResult, opts ...Option) (*RunOutcome, error) {
	cfg := c.cfg // copy — never mutate the shared Client (concurrency-safe)
	for _, o := range opts {
		o(&cfg)
	}
	if cfg.apiKey == "" {
		return nil, fmt.Errorf("theolens: apiKey is required (use WithAPIKey)")
	}
	if messages == nil {
		messages = []SDKMessage{} // always serialize `messages` as an array, never null
	}

	body, err := json.Marshal(runsBody{Messages: messages, Result: result, StartTimeMs: cfg.startTimeMs})
	if err != nil {
		return nil, fmt.Errorf("theolens: marshaling run payload: %w", err)
	}

	url := cfg.baseURL + cfg.basePath + "/runs"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("theolens: building request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+cfg.apiKey)
	req.Header.Set("Content-Type", "application/json")

	hc := cfg.httpClient
	if hc == nil {
		hc = http.DefaultClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		return nil, wrapTransport(url, err) // network failure — never retried
	}
	defer func() { _ = resp.Body.Close() }()

	respBody, readErr := io.ReadAll(resp.Body)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		// #65 — a billable run POST is never retried, so the response body is the ONLY rejected-span
		// signal. A truncated read (readErr) or a malformed body must surface, never degrade to a clean OK.
		if readErr != nil {
			return nil, wrapTransport(url, fmt.Errorf("reading run response body: %w", readErr))
		}
		return parseOutcome(url, respBody)
	}
	// Non-2xx: a partial error body still yields a best-effort typed envelope (readErr is tolerated here —
	// the status code alone already makes this an error).
	return nil, toError(resp, respBody)
}

// parseOutcome extracts {rejectedSpans, errorMessage} from a 2xx partialSuccess body. An EMPTY body is a
// clean success (the engine sends {partialSuccess:{}} on full success); a non-empty UNPARSEABLE body is a
// malformed response and surfaces as a transport error rather than a fabricated clean OK (#65).
func parseOutcome(url string, body []byte) (*RunOutcome, error) {
	var env struct {
		PartialSuccess struct {
			RejectedSpans int    `json:"rejectedSpans"`
			ErrorMessage  string `json:"errorMessage"`
		} `json:"partialSuccess"`
	}
	if len(body) > 0 {
		if err := json.Unmarshal(body, &env); err != nil {
			return nil, wrapTransport(url, fmt.Errorf("parsing run response body: %w", err))
		}
	}
	return &RunOutcome{RejectedSpans: env.PartialSuccess.RejectedSpans, ErrorMessage: env.PartialSuccess.ErrorMessage}, nil
}

// toError builds a *TheoLensError from a non-2xx response, parsing the {code,message} envelope and
// surfacing Retry-After on a 429.
func toError(resp *http.Response, body []byte) *TheoLensError {
	code, message := parseErrorEnvelope(body)
	if code == "" {
		code = "UNKNOWN"
	}
	if message == "" {
		message = "request failed"
	}
	tle := &TheoLensError{Status: resp.StatusCode, Code: code, Message: message}
	if resp.StatusCode == http.StatusTooManyRequests {
		tle.RetryAfter = resp.Header.Get("Retry-After")
	}
	return tle
}
