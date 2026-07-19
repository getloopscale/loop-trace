// Package theolens is a thin, stdlib-only Go ingest client for Theo Lens.
//
// It ports the Claude Code / @theokit/sdk SDKMessage run-event union to Go and
// POSTs a run batch to the native POST /v1/runs endpoint (M116) over net/http.
// The ENGINE maps the batch to spans; this client performs ZERO OTLP encoding.
//
// The module has NO third-party runtime dependency — only the Go standard
// library (net/http, encoding/json, context). A billable run POST is
// non-idempotent and is NEVER retried on an ambiguous timeout.
package theolens
