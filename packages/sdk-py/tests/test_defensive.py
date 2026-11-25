"""T2.2 — defensive degrade: opaque pass-through never raises; non-serializable fails fast typed."""

from __future__ import annotations

from typing import Any

import pytest

from looptrace_sdk import LoopTraceSerializationError, record_run

from ._transport_stub import BASE, CapturingTransport


def test_unknown_type_and_missing_optionals_serialize_without_raising() -> None:
    transport = CapturingTransport()
    # An unknown `type`, a message missing optional fields — the client never validates the surface.
    messages: list[Any] = [
        {"type": "some_future_event", "agent_id": "a", "run_id": "r", "novel_field": [1, 2, 3]},
        {"type": "task", "agent_id": "a", "run_id": "r"},
    ]
    record_run(messages, transport=transport, **BASE)
    assert transport.sent_json["messages"] == messages


def test_non_serializable_input_raises_typed_serialization_error() -> None:
    transport = CapturingTransport()
    messages: list[Any] = [{"type": "tool_call", "agent_id": "a", "run_id": "r", "call_id": "c", "name": "X", "status": "completed", "args": {"weird": {1, 2, 3}}}]

    with pytest.raises(LoopTraceSerializationError):
        record_run(messages, transport=transport, **BASE)

    # Fail-fast BEFORE any I/O — the transport is never touched.
    assert transport.calls == []
