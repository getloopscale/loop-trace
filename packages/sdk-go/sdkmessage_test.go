package theolens

import (
	"encoding/json"
	"testing"
)

// Opaque unstable-schema fields (Args/Result/Partial/Model/Message) are json.RawMessage:
// they marshal verbatim and an unknown `type` is carried through untouched (ADR D1). A nil
// opaque field is omitted (omitempty) — the engine, not the thin client, is the validator.
func TestOpaqueRawMessageFieldsPassThroughUnvalidated(t *testing.T) {
	weirdArgs := json.RawMessage(`{"weird":[1,{}]}`)
	msgs := []SDKMessage{
		{
			Type:   "totally_unknown_variant", // unknown discriminator carried through
			AgentID: "a",
			RunID:  "r",
			CallID: "c1",
			Name:   "X",
			Status: "completed",
			Args:   weirdArgs,
			// Result left nil → must be omitted by omitempty.
		},
	}

	out, err := json.Marshal(msgs)
	if err != nil {
		t.Fatalf("marshal returned error, want nil: %v", err)
	}

	var got []map[string]json.RawMessage
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("re-unmarshal failed: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("len(got) = %d, want 1", len(got))
	}
	m := got[0]

	// Unknown type carried verbatim.
	if string(m["type"]) != `"totally_unknown_variant"` {
		t.Errorf("type = %s, want %q", m["type"], "totally_unknown_variant")
	}
	// args round-trips the exact input bytes (JSON-equivalent).
	if !jsonEqual(t, m["args"], weirdArgs) {
		t.Errorf("args = %s, want %s", m["args"], weirdArgs)
	}
	// nil Result omitted.
	if _, present := m["result"]; present {
		t.Errorf("nil Result must be omitted, but `result` is present: %s", m["result"])
	}
}

// jsonEqual reports whether two JSON byte slices are structurally equal (order/whitespace-insensitive).
func jsonEqual(t *testing.T, a, b []byte) bool {
	t.Helper()
	var av, bv any
	if err := json.Unmarshal(a, &av); err != nil {
		t.Fatalf("jsonEqual: bad left JSON %q: %v", a, err)
	}
	if err := json.Unmarshal(b, &bv); err != nil {
		t.Fatalf("jsonEqual: bad right JSON %q: %v", b, err)
	}
	x, _ := json.Marshal(av)
	y, _ := json.Marshal(bv)
	return string(x) == string(y)
}
