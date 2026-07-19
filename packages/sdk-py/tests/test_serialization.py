"""T2.2 — ``record_run`` serializes ``{messages, result?, startTimeMs?}`` faithfully."""

from __future__ import annotations

from typing import Any

from theo_lens_sdk import RunResult, record_run

from ._transport_stub import BASE, CapturingTransport


def test_record_run_posts_messages_result_to_v1_runs() -> None:
    transport = CapturingTransport()
    messages: list[Any] = [
        {"type": "system", "subtype": "init", "agent_id": "a", "run_id": "r", "model": "claude-opus-4-8"},
        {"type": "user", "agent_id": "a", "run_id": "r", "message": {"role": "user", "content": [{"type": "text", "text": "hi"}]}},
    ]
    result: RunResult = {"usage": {"inputTokens": 10, "outputTokens": 2}}

    record_run(messages, result, transport=transport, **BASE)

    sent = transport.sent_json
    assert sent == {"messages": messages, "result": result}


def test_result_and_start_time_ms_omitted_when_none() -> None:
    transport = CapturingTransport()
    record_run([{"type": "request", "agent_id": "a", "run_id": "r", "request_id": "q"}], transport=transport, **BASE)

    sent = transport.sent_json
    assert "result" not in sent
    assert "startTimeMs" not in sent
    assert set(sent.keys()) == {"messages"}


def test_start_time_ms_included_when_set() -> None:
    transport = CapturingTransport()
    record_run([], transport=transport, start_time_ms=1_700_000_000_000, **BASE)
    assert transport.sent_json["startTimeMs"] == 1_700_000_000_000


def test_opaque_tool_args_and_result_survive_round_trip() -> None:
    transport = CapturingTransport()
    # Deeply-nested opaque args/result + non-ASCII — must pass through byte-for-byte, never validated.
    messages: list[Any] = [
        {
            "type": "tool_call",
            "agent_id": "a",
            "run_id": "r",
            "call_id": "c",
            "name": "Bash",
            "status": "completed",
            "args": {"cmd": "ls", "nested": {"deep": [1, 2, {"x": "café ☕"}]}},
            "result": {"stdout": "arquivo.txt", "unknown_future_field": True},
        }
    ]
    record_run(messages, transport=transport, **BASE)
    assert transport.sent_json["messages"] == messages
