"""Python mirror of the Claude Code / ``@theokit/sdk`` ``SDKMessage`` stream union + ``RunResult``.

A faithful port of ``packages/core/src/domain/theokit/sdk-message.ts``. This is a **documentation +
mypy aid, NOT a runtime validator** (blueprint D1): ``record_run`` treats a batch as opaque JSON and
passes it through untouched. The unstable fields the TS union marks "not part of the stable schema"
— ``args`` / ``result`` / ``partial`` / a tool_use ``input`` — are typed ``Any`` and are never
validated or coerced, so a future SDK field addition serializes transparently. A caller may pass
these ``TypedDict``\\s or plain ``dict``\\s interchangeably; the wire format is identical JSON.

Required-vs-optional fields are modeled with the stdlib pattern (a required base + a ``total=False``
subclass), since ``typing.Required`` / ``NotRequired`` are 3.11+ and this package targets 3.9.
Drift from the TS source of truth is caught by the shared ``theokit-vectors.json`` contract test,
not by this module.
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict, Union

# ---------------------------------------------------------------------------
# Content blocks
# ---------------------------------------------------------------------------


class TextBlock(TypedDict):
    type: Literal["text"]
    text: str


class ToolUseBlock(TypedDict):
    type: Literal["tool_use"]
    id: str
    name: str
    input: Any  # unstable → opaque


class ModelSelection(TypedDict, total=False):
    id: str
    params: list[Any]


# ---------------------------------------------------------------------------
# SDKMessage variants (discriminated on ``type``)
# ---------------------------------------------------------------------------


class _SystemRequired(TypedDict):
    type: Literal["system"]
    agent_id: str
    run_id: str


class SDKSystemMessage(_SystemRequired, total=False):
    subtype: Literal["init"]
    model: Any  # str | ModelSelection on the wire — opaque, extracted engine-side
    tools: list[str]


class _UserBody(TypedDict):
    role: Literal["user"]
    content: list[TextBlock]


class SDKUserMessage(TypedDict):
    type: Literal["user"]
    agent_id: str
    run_id: str
    message: _UserBody


class _AssistantBody(TypedDict):
    role: Literal["assistant"]
    content: list[TextBlock | ToolUseBlock]


class SDKAssistantMessage(TypedDict):
    type: Literal["assistant"]
    agent_id: str
    run_id: str
    message: _AssistantBody


class _ThinkingRequired(TypedDict):
    type: Literal["thinking"]
    agent_id: str
    run_id: str
    text: str


class SDKThinkingMessage(_ThinkingRequired, total=False):
    thinking_duration_ms: int


class _ToolCallRequired(TypedDict):
    type: Literal["tool_call"]
    agent_id: str
    run_id: str
    call_id: str
    name: str
    status: Literal["running", "completed", "error"]


class SDKToolCallMessage(_ToolCallRequired, total=False):
    args: Any  # unstable → opaque
    result: Any  # unstable → opaque
    truncated: dict[str, bool]


class _StatusRequired(TypedDict):
    type: Literal["status"]
    agent_id: str
    run_id: str
    status: Literal["CREATING", "RUNNING", "FINISHED", "ERROR", "CANCELLED", "EXPIRED"]


class SDKStatusMessage(_StatusRequired, total=False):
    message: str


class _TaskRequired(TypedDict):
    type: Literal["task"]
    agent_id: str
    run_id: str


class SDKTaskMessage(_TaskRequired, total=False):
    status: str
    text: str


class SDKRequestMessage(TypedDict):
    type: Literal["request"]
    agent_id: str
    run_id: str
    request_id: str


class SDKObjectDelta(TypedDict):
    type: Literal["object_delta"]
    agent_id: str
    run_id: str
    partial: Any  # unstable → opaque
    attempt: int


SDKMessage = Union[
    SDKSystemMessage,
    SDKUserMessage,
    SDKAssistantMessage,
    SDKThinkingMessage,
    SDKToolCallMessage,
    SDKStatusMessage,
    SDKTaskMessage,
    SDKRequestMessage,
    SDKObjectDelta,
]

# ---------------------------------------------------------------------------
# RunResult (terminal, once at run end)
# ---------------------------------------------------------------------------


class TokenUsage(TypedDict, total=False):
    inputTokens: int
    outputTokens: int
    cacheReadInputTokens: int
    cacheCreationInputTokens: int


class CostBreakdown(TypedDict, total=False):
    totalUsd: float
    status: str


class RunResult(TypedDict, total=False):
    usage: TokenUsage
    cost: CostBreakdown
