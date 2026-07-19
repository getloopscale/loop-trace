package theolens_test

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"

	theolens "github.com/usetheodev/theo-lens/packages/sdk-go"
)

// ExampleClient_RecordRun records a Claude Code / @theokit/sdk run to Theo Lens. The call site
// (construct client → build the batch → RecordRun → handle) is the ≤10-line happy path. The
// httptest.Server stands in for the real engine so the example is hermetic.
func ExampleClient_RecordRun() {
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"partialSuccess":{}}`))
	}))
	defer engine.Close()

	in, out := 1200, 340
	client := theolens.New(theolens.WithBaseURL(engine.URL), theolens.WithAPIKey("theo_live_xxx"))
	msgs := []theolens.SDKMessage{{Type: "system", Subtype: "init", AgentID: "agent-1", RunID: "run-1"}}
	result := &theolens.RunResult{Usage: &theolens.TokenUsage{InputTokens: &in, OutputTokens: &out}}
	outcome, err := client.RecordRun(context.Background(), msgs, result)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("all spans accepted:", outcome.OK())
	// Output: all spans accepted: true
}
