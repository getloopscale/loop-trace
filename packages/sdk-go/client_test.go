package theolens

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
)

// capture records what a stub server received, guarded for concurrent handlers.
type capture struct {
	mu     sync.Mutex
	count  int32
	method string
	path   string
	authz  string
	ctype  string
	body   []byte
}

func (c *capture) record(r *http.Request, body []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.method = r.Method
	c.path = r.URL.Path
	c.authz = r.Header.Get("Authorization")
	c.ctype = r.Header.Get("Content-Type")
	c.body = body
}

func readBody(t *testing.T, r *http.Request) []byte {
	t.Helper()
	b, err := io.ReadAll(r.Body)
	if err != nil {
		t.Fatalf("reading request body: %v", err)
	}
	return b
}

func sampleRun() ([]SDKMessage, *RunResult) {
	in, out := 100, 20
	msgs := []SDKMessage{
		{Type: "system", Subtype: "init", AgentID: "agentA", RunID: "run-42", Model: json.RawMessage(`"gpt-4o"`)},
	}
	res := &RunResult{Usage: &TokenUsage{InputTokens: &in, OutputTokens: &out}}
	return msgs, res
}

func TestRecordRunPostsBatchToV1Runs(t *testing.T) {
	cap := &capture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&cap.count, 1)
		cap.record(r, readBody(t, r))
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"partialSuccess":{}}`))
	}))
	defer srv.Close()

	msgs, res := sampleRun()
	var startMs int64 = 1_700_000_000_000
	c := New(WithBaseURL(srv.URL), WithAPIKey("theo_live_x"), WithStartTimeMs(startMs))
	out, err := c.RecordRun(context.Background(), msgs, res)
	if err != nil {
		t.Fatalf("RecordRun error = %v, want nil", err)
	}
	if out == nil || !out.OK() {
		t.Fatalf("outcome = %+v, want OK", out)
	}

	if cap.method != http.MethodPost {
		t.Errorf("method = %q, want POST", cap.method)
	}
	if cap.path != "/v1/runs" {
		t.Errorf("path = %q, want /v1/runs", cap.path)
	}
	if cap.authz != "Bearer theo_live_x" {
		t.Errorf("Authorization = %q, want Bearer theo_live_x", cap.authz)
	}
	if cap.ctype != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", cap.ctype)
	}

	// Assert the EXACT camelCase wire keys the engine reads (snake_case here would be a silent bug).
	var top map[string]json.RawMessage
	if err := json.Unmarshal(cap.body, &top); err != nil {
		t.Fatalf("body not a JSON object: %v (body=%s)", err, cap.body)
	}
	if _, ok := top["messages"]; !ok {
		t.Errorf("body missing `messages`; keys=%v", keysOf(top))
	}
	if _, ok := top["startTimeMs"]; !ok {
		t.Errorf("body missing camelCase `startTimeMs`; keys=%v", keysOf(top))
	}
	if _, ok := top["start_time_ms"]; ok {
		t.Errorf("body has snake_case `start_time_ms` — the engine ignores it (silent bug)")
	}
	// result.usage.inputTokens must be camelCase.
	var result map[string]json.RawMessage
	if err := json.Unmarshal(top["result"], &result); err != nil {
		t.Fatalf("result not an object: %v", err)
	}
	var usage map[string]json.RawMessage
	if err := json.Unmarshal(result["usage"], &usage); err != nil {
		t.Fatalf("result.usage not an object: %v", err)
	}
	if _, ok := usage["inputTokens"]; !ok {
		t.Errorf("result.usage missing camelCase `inputTokens`; keys=%v", keysOf(usage))
	}
	if _, ok := usage["input_tokens"]; ok {
		t.Errorf("result.usage has snake_case `input_tokens` — the engine ignores it (silent bug)")
	}
	if _, ok := usage["outputTokens"]; !ok {
		t.Errorf("result.usage missing camelCase `outputTokens`")
	}
}

// result / startTimeMs are omitted from the body when not supplied.
func TestRecordRunOmitsNilResultAndStartTime(t *testing.T) {
	cap := &capture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cap.record(r, readBody(t, r))
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"partialSuccess":{}}`))
	}))
	defer srv.Close()

	msgs, _ := sampleRun()
	c := New(WithBaseURL(srv.URL), WithAPIKey("k"))
	if _, err := c.RecordRun(context.Background(), msgs, nil); err != nil {
		t.Fatalf("RecordRun error = %v", err)
	}
	var top map[string]json.RawMessage
	_ = json.Unmarshal(cap.body, &top)
	if _, ok := top["result"]; ok {
		t.Errorf("nil result must be omitted; body=%s", cap.body)
	}
	if _, ok := top["startTimeMs"]; ok {
		t.Errorf("unset startTimeMs must be omitted; body=%s", cap.body)
	}
	// messages is always present as an array.
	var msgsArr []json.RawMessage
	if err := json.Unmarshal(top["messages"], &msgsArr); err != nil {
		t.Errorf("messages must be a JSON array: %v", err)
	}
}

func TestBasePathSwapEdge(t *testing.T) {
	cap := &capture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cap.record(r, readBody(t, r))
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"partialSuccess":{}}`))
	}))
	defer srv.Close()

	msgs, _ := sampleRun()
	c := New(WithBaseURL(srv.URL), WithAPIKey("k"), WithBasePath("/v1/lens"))
	if _, err := c.RecordRun(context.Background(), msgs, nil); err != nil {
		t.Fatalf("RecordRun error = %v", err)
	}
	if cap.path != "/v1/lens/runs" {
		t.Errorf("path = %q, want /v1/lens/runs", cap.path)
	}
}

func TestPartialSuccessIsSurfacedNotErrored(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"partialSuccess":{"rejectedSpans":2,"errorMessage":"bad span"}}`))
	}))
	defer srv.Close()

	msgs, _ := sampleRun()
	c := New(WithBaseURL(srv.URL), WithAPIKey("k"))
	out, err := c.RecordRun(context.Background(), msgs, nil)
	if err != nil {
		t.Fatalf("populated partialSuccess must NOT be an error, got %v", err)
	}
	if out.OK() {
		t.Errorf("out.OK() = true, want false (2 spans rejected)")
	}
	if out.RejectedSpans != 2 {
		t.Errorf("RejectedSpans = %d, want 2", out.RejectedSpans)
	}
	if out.ErrorMessage != "bad span" {
		t.Errorf("ErrorMessage = %q, want 'bad span'", out.ErrorMessage)
	}
}

func TestRecordRunMaps413ToTypedError(t *testing.T) {
	var count int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&count, 1)
		w.WriteHeader(413)
		_, _ = w.Write([]byte(`{"code":"PAYLOAD_TOO_LARGE","message":"too big"}`))
	}))
	defer srv.Close()

	msgs, _ := sampleRun()
	c := New(WithBaseURL(srv.URL), WithAPIKey("k"))
	_, err := c.RecordRun(context.Background(), msgs, nil)

	var tle *TheoLensError
	if !errors.As(err, &tle) {
		t.Fatalf("err = %v, want *TheoLensError", err)
	}
	if tle.Status != 413 || tle.Code != "PAYLOAD_TOO_LARGE" {
		t.Errorf("got {Status:%d Code:%q}, want {413 PAYLOAD_TOO_LARGE}", tle.Status, tle.Code)
	}
	if n := atomic.LoadInt32(&count); n != 1 {
		t.Errorf("server saw %d requests, want exactly 1 (a run POST must NOT be retried)", n)
	}
}

func TestRecordRunMapsTypedErrorEnvelope(t *testing.T) {
	cases := []struct {
		status int
		code   string
	}{
		{400, "INVALID_BODY"},
		{415, "UNSUPPORTED_MEDIA_TYPE"},
		{401, "UNAUTHORIZED"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.code, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(`{"code":"` + tc.code + `","message":"x"}`))
			}))
			defer srv.Close()
			msgs, _ := sampleRun()
			c := New(WithBaseURL(srv.URL), WithAPIKey("k"))
			_, err := c.RecordRun(context.Background(), msgs, nil)
			var tle *TheoLensError
			if !errors.As(err, &tle) {
				t.Fatalf("err = %v, want *TheoLensError", err)
			}
			if tle.Status != tc.status || tle.Code != tc.code {
				t.Errorf("got {%d %q}, want {%d %q}", tle.Status, tle.Code, tc.status, tc.code)
			}
		})
	}
}

func TestRecordRunSurfaces429RetryAfter(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(429)
		_, _ = w.Write([]byte(`{"code":"RATE_LIMITED","message":"slow down"}`))
	}))
	defer srv.Close()

	msgs, _ := sampleRun()
	c := New(WithBaseURL(srv.URL), WithAPIKey("k"))
	_, err := c.RecordRun(context.Background(), msgs, nil)
	var tle *TheoLensError
	if !errors.As(err, &tle) {
		t.Fatalf("err = %v, want *TheoLensError", err)
	}
	if tle.Status != 429 || tle.Code != "RATE_LIMITED" {
		t.Errorf("got {%d %q}, want {429 RATE_LIMITED}", tle.Status, tle.Code)
	}
	if tle.RetryAfter != "30" {
		t.Errorf("RetryAfter = %q, want 30 (must be surfaced)", tle.RetryAfter)
	}
}

func TestRecordRunNetworkFailureWrapped(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	url := srv.URL
	srv.Close() // now nothing is listening → connection refused

	msgs, _ := sampleRun()
	c := New(WithBaseURL(url), WithAPIKey("k"))
	_, err := c.RecordRun(context.Background(), msgs, nil)
	if err == nil {
		t.Fatalf("want a transport error, got nil")
	}
	if !errors.Is(err, ErrTransport) {
		t.Errorf("errors.Is(err, ErrTransport) = false, want true; err=%v", err)
	}
	var tle *TheoLensError
	if errors.As(err, &tle) {
		t.Errorf("a network failure must NOT be a *TheoLensError; got %v", tle)
	}
}

func TestRecordRunContextCancellation(t *testing.T) {
	msgs, _ := sampleRun()
	c := New(WithBaseURL("http://127.0.0.1:0"), WithAPIKey("k"))
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled before the call

	_, err := c.RecordRun(ctx, msgs, nil)
	if err == nil {
		t.Fatalf("want a context error, got nil")
	}
	if !errors.Is(err, context.Canceled) {
		t.Errorf("errors.Is(err, context.Canceled) = false, want true; err=%v", err)
	}
}

func TestRecordRun_concurrent_safe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = readBody(t, r), 0
		w.WriteHeader(200)
		_, _ = w.Write([]byte(`{"partialSuccess":{}}`))
	}))
	defer srv.Close()

	// ONE shared Client used by N goroutines (the -race detector is the oracle).
	c := New(WithBaseURL(srv.URL), WithAPIKey("theo_live_shared"))
	const n = 40
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			msgs, res := sampleRun()
			_, errs[i] = c.RecordRun(context.Background(), msgs, res)
		}(i)
	}
	wg.Wait()
	for i, e := range errs {
		if e != nil {
			t.Errorf("goroutine %d: RecordRun error = %v", i, e)
		}
	}
}

func keysOf(m map[string]json.RawMessage) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	return ks
}
