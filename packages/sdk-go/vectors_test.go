package looptrace

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

// vectorsPath is the shared, language-neutral behavior fixture exported once from
// theokit-vectors.ts and loaded identically by the TS, Python (M124), and Go suites (ADR D3).
const vectorsPath = "../core/src/domain/theokit/theokit-vectors.json"

// vector is one entry of theokit-vectors.json: the INPUT batch only (the vitest assert closures
// are non-portable and stay in TS). messages/result are kept raw for JSON-equivalence comparison.
type vector struct {
	Name     string          `json:"name"`
	Messages json.RawMessage `json:"messages"`
	Result   json.RawMessage `json:"result,omitempty"`
}

func loadVectors(t *testing.T) []vector {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath)
	if err != nil {
		t.Fatalf("reading shared vectors %s: %v", vectorsPath, err)
	}
	var vs []vector
	if err := json.Unmarshal(raw, &vs); err != nil {
		t.Fatalf("parsing shared vectors: %v", err)
	}
	return vs
}

// The drift guard: the Go client must marshal each of the 18 shared batches into a body whose
// `messages` (and `result`) round-trip JSON-equivalent to the vector — a struct that drops or
// mistypes a field fails a vector.
func TestAll18VectorsMarshalToRunsBody(t *testing.T) {
	vectors := loadVectors(t)
	if len(vectors) != 18 {
		t.Fatalf("len(vectors) = %d, want 18 (the shared contract)", len(vectors))
	}

	for _, v := range vectors {
		v := v
		t.Run(v.Name, func(t *testing.T) {
			// Decode the vector batch into the Go structs the client marshals.
			var msgs []SDKMessage
			if err := json.Unmarshal(v.Messages, &msgs); err != nil {
				t.Fatalf("unmarshal vector messages into []SDKMessage: %v", err)
			}
			var result *RunResult
			if len(v.Result) > 0 {
				result = &RunResult{}
				if err := json.Unmarshal(v.Result, result); err != nil {
					t.Fatalf("unmarshal vector result into *RunResult: %v", err)
				}
			}

			cap := &capture{}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				cap.record(r, readBody(t, r))
				w.WriteHeader(200)
				_, _ = w.Write([]byte(`{"partialSuccess":{}}`))
			}))
			defer srv.Close()

			c := New(WithBaseURL(srv.URL), WithAPIKey("looptrace_live_vec"))
			if _, err := c.RecordRun(context.Background(), msgs, result); err != nil {
				t.Fatalf("RecordRun error = %v", err)
			}

			var top map[string]json.RawMessage
			if err := json.Unmarshal(cap.body, &top); err != nil {
				t.Fatalf("captured body not a JSON object: %v", err)
			}
			// messages round-trips the vector verbatim (the cross-language contract).
			if !jsonEqual(t, top["messages"], v.Messages) {
				t.Errorf("messages diverged.\n got: %s\nwant: %s", top["messages"], v.Messages)
			}
			// result round-trips when the vector carries one.
			if len(v.Result) > 0 {
				if !jsonEqual(t, top["result"], v.Result) {
					t.Errorf("result diverged.\n got: %s\nwant: %s", top["result"], v.Result)
				}
			}
		})
	}
}

// Gated hermetic e2e: POST each of the 18 shared batches to a REAL running engine /v1/runs and
// assert a 200 with a clean partialSuccess (no rejectedSpans). Skipped unless LOOPTRACE_E2E_URL is
// set, so the default suite needs no engine. Requires LOOPTRACE_E2E_KEY (a looptrace_live_* key).
func TestAll18VectorsAcceptedByEngine(t *testing.T) {
	baseURL := os.Getenv("LOOPTRACE_E2E_URL")
	if baseURL == "" {
		t.Skip("LOOPTRACE_E2E_URL unset — skipping hermetic engine e2e")
	}
	apiKey := os.Getenv("LOOPTRACE_E2E_KEY")
	if apiKey == "" {
		t.Fatal("LOOPTRACE_E2E_URL is set but LOOPTRACE_E2E_KEY (a looptrace_live_* key) is required")
	}
	basePath := os.Getenv("LOOPTRACE_E2E_BASE_PATH")

	vectors := loadVectors(t)
	if len(vectors) != 18 {
		t.Fatalf("len(vectors) = %d, want 18", len(vectors))
	}

	opts := []Option{WithBaseURL(baseURL), WithAPIKey(apiKey)}
	if basePath != "" {
		opts = append(opts, WithBasePath(basePath))
	}
	c := New(opts...)

	for _, v := range vectors {
		v := v
		t.Run(v.Name, func(t *testing.T) {
			var msgs []SDKMessage
			if err := json.Unmarshal(v.Messages, &msgs); err != nil {
				t.Fatalf("unmarshal messages: %v", err)
			}
			var result *RunResult
			if len(v.Result) > 0 {
				result = &RunResult{}
				if err := json.Unmarshal(v.Result, result); err != nil {
					t.Fatalf("unmarshal result: %v", err)
				}
			}
			out, err := c.RecordRun(context.Background(), msgs, result)
			if err != nil {
				t.Fatalf("engine rejected vector: %v", err)
			}
			if !out.OK() {
				t.Errorf("engine dropped %d span(s): %s", out.RejectedSpans, out.ErrorMessage)
			}
		})
	}
}
