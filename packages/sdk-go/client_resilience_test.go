package looptrace

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// #65 — a truncated / unusable 2xx response to a billable, non-idempotent run POST must NOT be
// misreported as a clean success. The client cannot retry a billable POST, so the response body is
// its only rejected-span signal; a read error or a malformed body has to surface, not degrade to OK.

// errBody is a response body whose Read always fails — simulates a connection truncated mid-body.
type errBody struct{}

func (errBody) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
func (errBody) Close() error             { return nil }

type errBodyRoundTripper struct{}

func (errBodyRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: 200, Body: errBody{}, Header: make(http.Header)}, nil
}

func TestRecordRun2xxReadErrorSurfacesTransport(t *testing.T) {
	msgs, _ := sampleRun()
	c := New(
		WithBaseURL("http://engine.local"),
		WithAPIKey("k"),
		WithHTTPClient(&http.Client{Transport: errBodyRoundTripper{}}),
	)
	out, err := c.RecordRun(context.Background(), msgs, nil)
	if err == nil {
		t.Fatalf("a 2xx body read failure must error, not report a clean outcome; got out=%+v", out)
	}
	if !errors.Is(err, ErrTransport) {
		t.Errorf("errors.Is(err, ErrTransport) = false, want true; err=%v", err)
	}
}

func TestRecordRunMalformed2xxBodyErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"partialSuccess":{"rejectedSpans":`)) // truncated JSON
	}))
	defer srv.Close()

	msgs, _ := sampleRun()
	c := New(WithBaseURL(srv.URL), WithAPIKey("k"))
	out, err := c.RecordRun(context.Background(), msgs, nil)
	if err == nil {
		t.Fatalf("a malformed 2xx body must error, not report a clean outcome; got out=%+v", out)
	}
}

// An EMPTY 2xx body is still a clean success (rejectedSpans 0) — the engine's partialSuccess is {} on
// full success; guard that the fix does not over-reject the legitimate empty case.
func TestRecordRunEmpty2xxBodyIsCleanOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
	}))
	defer srv.Close()

	msgs, _ := sampleRun()
	c := New(WithBaseURL(srv.URL), WithAPIKey("k"))
	out, err := c.RecordRun(context.Background(), msgs, nil)
	if err != nil {
		t.Fatalf("an empty 2xx body is a clean success, got err=%v", err)
	}
	if !out.OK() {
		t.Errorf("empty 2xx body → OK(), got %+v", out)
	}
}
