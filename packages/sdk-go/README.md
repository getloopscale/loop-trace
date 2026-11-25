# looptrace — Go ingest client for LoopTrace

A thin, **stdlib-only** Go client that records a Claude Code / [`@theokit/sdk`](https://github.com/getloopscale)
run to LoopTrace. It POSTs an `SDKMessage` batch to the native `POST /v1/runs` endpoint; the
**engine** maps the batch to spans — the client performs **zero OTLP encoding** and has **no
third-party runtime dependency** (`net/http` + `encoding/json` + `context` only).

## Install

```sh
go get github.com/getloopscale/looptrace/packages/sdk-go
```

## Usage

```go
package main

import (
	"context"
	"log"

	looptrace "github.com/getloopscale/looptrace/packages/sdk-go"
)

func main() {
	client := looptrace.New(
		looptrace.WithBaseURL("https://app.getloopscale.com"),
		looptrace.WithAPIKey("looptrace_live_xxx"), // a per-tenant key (Authorization: Bearer)
	)

	in, out := 1200, 340
	msgs := []looptrace.SDKMessage{
		{Type: "system", Subtype: "init", AgentID: "agent-1", RunID: "run-1", Model: []byte(`"claude-opus-4-8"`)},
	}
	result := &looptrace.RunResult{Usage: &looptrace.TokenUsage{InputTokens: &in, OutputTokens: &out}}

	outcome, err := client.RecordRun(context.Background(), msgs, result)
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("recorded run; all spans accepted: %v", outcome.OK())
}
```

## Behind the unified edge

Direct consumers use the default base path `/v1`. Consumers behind the LoopZero unified edge (one
`looptrace_live_*` key, per-tenant isolation) swap the path root to `/v1/lens`:

```go
client := looptrace.New(
	looptrace.WithBaseURL("https://app.getloopscale.com"),
	looptrace.WithAPIKey("looptrace_live_xxx"),
	looptrace.WithBasePath("/v1/lens"), // → POST https://app.getloopscale.com/v1/lens/runs
)
```

## Error handling

`RecordRun` returns explicit, typed errors — nothing is swallowed:

```go
outcome, err := client.RecordRun(ctx, msgs, result)

var apiErr *looptrace.LoopTraceError
switch {
case err == nil:
	if !outcome.OK() {
		// 200 with a populated partialSuccess: the engine accepted the run but dropped
		// outcome.RejectedSpans span(s). Surfaced, never raised.
		log.Printf("partial: %d rejected (%s)", outcome.RejectedSpans, outcome.ErrorMessage)
	}
case errors.As(err, &apiErr):
	// A non-2xx: apiErr.Status + apiErr.Code (INVALID_BODY / PAYLOAD_TOO_LARGE /
	// UNSUPPORTED_MEDIA_TYPE / RATE_LIMITED / …). On a 429, apiErr.RetryAfter carries the
	// Retry-After header — the caller owns backoff; the client never auto-retries.
	log.Printf("engine error %d %s", apiErr.Status, apiErr.Code)
case errors.Is(err, looptrace.ErrTransport):
	// A network failure. A run POST is non-idempotent (M108) so it is NOT retried here.
	log.Printf("transport failure: %v", err)
}
```

`ctx` cancellation / deadline aborts the in-flight POST and returns the context error.

## Options

| Option | Purpose |
|---|---|
| `WithBaseURL(url)` | engine or edge origin (no trailing slash) |
| `WithAPIKey(key)` | `looptrace_live_*` per-tenant key → `Authorization: Bearer` |
| `WithBasePath(path)` | `/v1` (direct) or `/v1/lens` (unified edge) |
| `WithHTTPClient(hc)` | inject a custom `*http.Client` (timeouts, transport, tests) |
| `WithStartTimeMs(ms)` | base epoch-ms forwarded to the engine mapper (deterministic spans) |

Options may be passed to `New(...)` or per call to `RecordRun(..., opts...)` — per-call options win.

## Development

```sh
cd packages/sdk-go
go build ./... && go vet ./... && go test ./... && go test -race ./...
golangci-lint run
```

The 18-vector cross-language contract test (`TestAll18VectorsMarshalToRunsBody`) loads the shared
`theokit-vectors.json` — the same behavior spec the TypeScript and Python (M124) suites pin. The
hermetic engine e2e (`TestAll18VectorsAcceptedByEngine`) is skipped unless `LOOPTRACE_E2E_URL`
(and `LOOPTRACE_E2E_KEY`) are set.
