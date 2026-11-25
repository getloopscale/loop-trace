"""T2.1 — the SDKMessage TypedDict mirror: all 9 variants type-check (mypy strict) and serialize.

Each literal below is annotated with its specific variant, so ``mypy`` verifies the mirror against
the TS union; the batch then round-trips through ``json.dumps`` (via ``record_run``) unchanged,
including the opaque ``args`` / ``result`` / ``partial`` / tool_use ``input`` fields.
"""

from __future__ import annotations

import json

from looptrace_sdk import SDKMessage, record_run
from looptrace_sdk.messages import (
    SDKAssistantMessage,
    SDKObjectDelta,
    SDKRequestMessage,
    SDKStatusMessage,
    SDKSystemMessage,
    SDKTaskMessage,
    SDKThinkingMessage,
    SDKToolCallMessage,
    SDKUserMessage,
)

from ._transport_stub import BASE, CapturingTransport


def test_all_nine_variants_typecheck_and_serialize() -> None:
    system: SDKSystemMessage = {"type": "system", "agent_id": "a", "run_id": "r", "subtype": "init", "model": {"id": "claude-opus-4-8", "params": [{"p": 1}]}, "tools": ["Bash", "Read"]}
    user: SDKUserMessage = {"type": "user", "agent_id": "a", "run_id": "r", "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]}}
    assistant: SDKAssistantMessage = {"type": "assistant", "agent_id": "a", "run_id": "r", "message": {"role": "assistant", "content": [{"type": "text", "text": "ok"}, {"type": "tool_use", "id": "u1", "name": "search", "input": {"q": "cats"}}]}}
    thinking: SDKThinkingMessage = {"type": "thinking", "agent_id": "a", "run_id": "r", "text": "hmm", "thinking_duration_ms": 250}
    tool_call: SDKToolCallMessage = {"type": "tool_call", "agent_id": "a", "run_id": "r", "call_id": "c", "name": "Bash", "status": "completed", "args": {"cmd": "ls"}, "result": "file.txt"}
    status: SDKStatusMessage = {"type": "status", "agent_id": "a", "run_id": "r", "status": "ERROR", "message": "boom"}
    task: SDKTaskMessage = {"type": "task", "agent_id": "a", "run_id": "r", "status": "working", "text": "milestone"}
    request: SDKRequestMessage = {"type": "request", "agent_id": "a", "run_id": "r", "request_id": "q1"}
    object_delta: SDKObjectDelta = {"type": "object_delta", "agent_id": "a", "run_id": "r", "partial": {"x": 1}, "attempt": 1}

    batch: list[SDKMessage] = [system, user, assistant, thinking, tool_call, status, task, request, object_delta]

    # Each variant is a valid JSON object on its own.
    for message in batch:
        json.dumps(message)

    transport = CapturingTransport()
    record_run(batch, transport=transport, **BASE)
    assert transport.sent_json["messages"] == batch
    assert len(transport.sent_json["messages"]) == 9
