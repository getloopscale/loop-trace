"""T2.3 — HTTP request shaping: method, Bearer auth, JSON content-type, base_path swap."""

from __future__ import annotations

from theo_lens_sdk import record_run

from ._transport_stub import BASE, CapturingTransport


def test_record_run_sends_post_bearer_auth_and_json_content_type() -> None:
    transport = CapturingTransport()
    record_run([], transport=transport, **BASE)

    call = transport.last
    assert call["method"] == "POST"
    assert call["headers"]["authorization"] == "Bearer theo_live_x"
    assert call["headers"]["content-type"] == "application/json"


def test_default_base_path_posts_to_v1_runs() -> None:
    transport = CapturingTransport()
    record_run([], transport=transport, **BASE)
    assert transport.last["url"] == "http://engine.test/v1/runs"


def test_base_path_swap_changes_only_the_url() -> None:
    default_t = CapturingTransport()
    edge_t = CapturingTransport()
    record_run([], transport=default_t, **BASE)
    record_run([], transport=edge_t, base_path="/v1/lens", **BASE)

    assert default_t.last["url"] == "http://engine.test/v1/runs"
    assert edge_t.last["url"] == "http://engine.test/v1/lens/runs"
    # Everything except the URL is identical.
    assert default_t.last["headers"] == edge_t.last["headers"]
    assert default_t.last["body"] == edge_t.last["body"]
    assert default_t.last["method"] == edge_t.last["method"]
