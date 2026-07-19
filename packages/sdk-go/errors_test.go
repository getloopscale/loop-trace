package theolens

import (
	"errors"
	"fmt"
	"testing"
)

// A non-2xx surfaces an explicit typed *TheoLensError carrying the parsed {code,message}
// envelope + the HTTP Status, recoverable via errors.As (error-handling.md §2).
func TestTheoLensErrorCarriesStatusAndCode(t *testing.T) {
	body := []byte(`{"code":"PAYLOAD_TOO_LARGE","message":"run body exceeds the ingest size limit"}`)
	code, message := parseErrorEnvelope(body)

	err := error(&TheoLensError{Status: 413, Code: code, Message: message})

	var tle *TheoLensError
	if !errors.As(err, &tle) {
		t.Fatalf("errors.As failed to recover *TheoLensError from %v", err)
	}
	if tle.Status != 413 {
		t.Errorf("Status = %d, want 413", tle.Status)
	}
	if tle.Code != "PAYLOAD_TOO_LARGE" {
		t.Errorf("Code = %q, want PAYLOAD_TOO_LARGE", tle.Code)
	}
	if tle.Message != "run body exceeds the ingest size limit" {
		t.Errorf("Message = %q, want the envelope message", tle.Message)
	}
}

// A malformed / empty error body degrades to an UNKNOWN code rather than panicking.
func TestParseErrorEnvelopeDegradesOnGarbage(t *testing.T) {
	code, message := parseErrorEnvelope([]byte("not json at all"))
	if code != "" || message != "" {
		t.Errorf("garbage body: got code=%q message=%q, want empty/empty", code, message)
	}
}

// A transport failure is wrapped errors.Is-friendly: it matches the ErrTransport sentinel AND
// unwraps to the underlying cause (so a ctx error is still discoverable up the chain).
func TestWrapTransportIsErrorsIsFriendly(t *testing.T) {
	cause := errors.New("connection refused")
	wrapped := wrapTransport("http://x/v1/runs", cause)

	if !errors.Is(wrapped, ErrTransport) {
		t.Errorf("errors.Is(wrapped, ErrTransport) = false, want true")
	}
	if !errors.Is(wrapped, cause) {
		t.Errorf("errors.Is(wrapped, cause) = false, want true (underlying cause must remain discoverable)")
	}
	// Also unwrappable via errors.Unwrap → the cause.
	if got := errors.Unwrap(wrapped); got == nil {
		t.Errorf("errors.Unwrap(wrapped) = nil, want non-nil")
	}
	_ = fmt.Sprint(wrapped) // Error() must not panic
}
