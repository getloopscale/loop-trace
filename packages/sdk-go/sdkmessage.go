package theolens

import "encoding/json"

// SDKMessage is the Go port of the Claude Code / @theokit/sdk `SDKMessage` stream union
// (packages/core/src/domain/theokit/sdk-message.ts). It is modeled as ONE flat struct with
// a `Type` discriminator plus the superset of stable fields (each omitempty). Every
// unstable-schema field is json.RawMessage so unknown bytes pass through verbatim (ADR D1):
// the engine — not this thin client — validates the batch.
//
// WIRE CASING IS LOAD-BEARING. Every json tag mirrors the TS union's serialized key exactly
// (snake_case message fields: agent_id/run_id/call_id/request_id/thinking_duration_ms). A wrong
// tag is silently ignored by the engine mapper and would produce wrong spans.
type SDKMessage struct {
	// Type discriminates the variant: system, user, assistant, thinking, tool_call, status,
	// task, request, object_delta (an unknown value is carried through untouched).
	Type string `json:"type"`

	// Common identity fields shared by every variant.
	AgentID string `json:"agent_id,omitempty"`
	RunID   string `json:"run_id,omitempty"`

	// system (SDKSystemMessage).
	Subtype string          `json:"subtype,omitempty"`
	Model   json.RawMessage `json:"model,omitempty"` // string | ModelSelection{id,params} — opaque
	Tools   []string        `json:"tools,omitempty"`

	// user / assistant carry an object `message`; status carries a STRING `message`. Opaque
	// json.RawMessage absorbs both polymorphic shapes without a custom unmarshaller.
	Message json.RawMessage `json:"message,omitempty"`

	// thinking (SDKThinkingMessage) / task (SDKTaskMessage) `text`.
	Text               string `json:"text,omitempty"`
	ThinkingDurationMs *int   `json:"thinking_duration_ms,omitempty"`

	// tool_call (SDKToolUseMessage). Args/Result/Truncated are unstable → opaque.
	CallID    string          `json:"call_id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Status    string          `json:"status,omitempty"`
	Args      json.RawMessage `json:"args,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Truncated json.RawMessage `json:"truncated,omitempty"`

	// request (SDKRequestMessage).
	RequestID string `json:"request_id,omitempty"`

	// object_delta (SDKObjectDelta). Partial is unstable → opaque.
	Partial json.RawMessage `json:"partial,omitempty"`
	Attempt *int            `json:"attempt,omitempty"`
}

// TokenUsage mirrors `RunResult.usage`. The wire keys are camelCase (inputTokens/outputTokens/
// cacheReadInputTokens/cacheCreationInputTokens) — the engine reads them verbatim. Pointers so a
// legitimate zero is preserved rather than dropped by omitempty.
type TokenUsage struct {
	InputTokens              *int `json:"inputTokens,omitempty"`
	OutputTokens             *int `json:"outputTokens,omitempty"`
	CacheReadInputTokens     *int `json:"cacheReadInputTokens,omitempty"`
	CacheCreationInputTokens *int `json:"cacheCreationInputTokens,omitempty"`
}

// CostBreakdown mirrors `RunResult.cost` (advisory). `totalUsd` is camelCase on the wire.
type CostBreakdown struct {
	TotalUsd *float64 `json:"totalUsd,omitempty"`
	Status   string   `json:"status,omitempty"`
}

// RunResult is the terminal per-run usage + optional cost, sent ONCE at run end.
type RunResult struct {
	Usage *TokenUsage    `json:"usage,omitempty"`
	Cost  *CostBreakdown `json:"cost,omitempty"`
}
