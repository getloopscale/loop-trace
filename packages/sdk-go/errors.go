package theolens

import (
	"encoding/json"
	"errors"
	"fmt"
)

// ErrTransport is the sentinel every network-level failure matches via errors.Is. A run POST is
// non-idempotent and billable, so an ambiguous timeout surfaces here and is NEVER auto-retried
// (the M108 lesson) — the caller owns any backoff.
var ErrTransport = errors.New("theolens: transport failure")

// TheoLensError is a non-2xx response from the engine, carrying the parsed {code,message} envelope
// plus the HTTP Status. On a 429 the Retry-After header value is surfaced verbatim (never used to
// auto-retry). A caller recovers it with errors.As(err, &TheoLensError{}).
type TheoLensError struct {
	// Status is the HTTP status code (400/413/415/429/401/403/…).
	Status int
	// Code is the stable engine error code (e.g. PAYLOAD_TOO_LARGE); "UNKNOWN" when the body carried none.
	Code string
	// Message is the human-facing envelope message.
	Message string
	// RetryAfter is the raw Retry-After header value on a 429 (seconds), empty when absent.
	RetryAfter string
}

func (e *TheoLensError) Error() string {
	return fmt.Sprintf("theolens: [%d %s] %s", e.Status, e.Code, e.Message)
}

// transportError wraps a network-level cause so errors.Is matches BOTH the ErrTransport sentinel
// and the underlying cause (e.g. context.Canceled reachable through the *url.Error chain).
type transportError struct {
	url   string
	cause error
}

func (e *transportError) Error() string {
	return fmt.Sprintf("theolens: transport POSTing to %s: %v", e.url, e.cause)
}

func (e *transportError) Unwrap() error { return e.cause }

func (e *transportError) Is(target error) bool { return target == ErrTransport }

// wrapTransport wraps a network failure in an errors.Is-friendly transport error.
func wrapTransport(url string, cause error) error {
	return &transportError{url: url, cause: cause}
}

// parseErrorEnvelope extracts the canonical {code,message} envelope from a non-2xx body. A body that
// is not the expected JSON object degrades to empty strings rather than raising — the caller supplies
// fallbacks (never a panic at the boundary).
func parseErrorEnvelope(body []byte) (code, message string) {
	var env struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return "", ""
	}
	return env.Code, env.Message
}
