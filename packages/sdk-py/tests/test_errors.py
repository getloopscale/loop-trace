"""T2.4 — status→typed-error mapping, transport error (no retry), partial-success surfacing."""

from __future__ import annotations

import urllib.error
from typing import Any
from unittest import mock

import pytest

from theo_lens_sdk import (
    TheoLensError,
    TheoLensTransportError,
    record_run,
)
from theo_lens_sdk.client import Response, urllib_transport

from ._transport_stub import BASE, CapturingTransport, RaisingTransport


def _err_response(status: int, code: str, *, headers: dict[str, str] | None = None) -> Response:
    return Response(status, headers or {}, f'{{"code":"{code}","message":"boom"}}'.encode())


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (400, "INVALID_BODY"),
        (413, "PAYLOAD_TOO_LARGE"),
        (415, "UNSUPPORTED_MEDIA_TYPE"),
        (429, "RATE_LIMITED"),
        (401, "UNAUTHORIZED"),
    ],
)
def test_record_run_maps_non_2xx_to_typed_error(status: int, code: str) -> None:
    transport = CapturingTransport(response=_err_response(status, code))
    with pytest.raises(TheoLensError) as excinfo:
        record_run([], transport=transport, **BASE)

    err = excinfo.value
    assert err.status == status
    assert err.code == code
    assert err.message == "boom"


def test_429_exposes_retry_after_and_does_not_retry() -> None:
    transport = CapturingTransport(
        response=_err_response(429, "RATE_LIMITED", headers={"Retry-After": "12"})
    )
    with pytest.raises(TheoLensError) as excinfo:
        record_run([], transport=transport, **BASE)

    assert excinfo.value.retry_after == 12
    assert len(transport.calls) == 1  # M108 — a rate-limited billable POST is not retried


def test_network_failure_raises_typed_transport_error_no_retry() -> None:
    transport = RaisingTransport(TheoLensTransportError("connection reset"))
    with pytest.raises(TheoLensTransportError):
        record_run([], transport=transport, **BASE)
    assert transport.calls == 1  # invoked exactly once — never retried on an ambiguous failure


def test_urllib_transport_maps_oserror_to_transport_error() -> None:
    # The default transport must translate a raw network OSError into the typed transport error.
    with (
        mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("dns")),
        pytest.raises(TheoLensTransportError),
    ):
        urllib_transport(
            url="http://engine.test/v1/runs",
            method="POST",
            headers={"content-type": "application/json"},
            body=b"{}",
            timeout=1.0,
        )


def test_urllib_transport_maps_incomplete_read_to_transport_error() -> None:
    # #66 — a truncated body raises http.client.IncompleteRead (an HTTPException, NOT an OSError) from
    # resp.read(); the default transport must still honor the typed-error boundary, not leak the bare
    # stdlib exception.
    import http.client

    resp = mock.MagicMock()
    resp.status = 200
    resp.headers = {}
    resp.read.side_effect = http.client.IncompleteRead(b"partial")
    cm = mock.MagicMock()
    cm.__enter__.return_value = resp
    cm.__exit__.return_value = False
    with (
        mock.patch("urllib.request.urlopen", return_value=cm),
        pytest.raises(TheoLensTransportError),
    ):
        urllib_transport(
            url="http://engine.test/v1/runs",
            method="POST",
            headers={"content-type": "application/json"},
            body=b"{}",
            timeout=1.0,
        )


def test_partial_success_returns_rejected_count_not_error() -> None:
    body = b'{"partialSuccess":{"rejectedSpans":2,"errorMessage":"invalid OTLP span"}}'
    transport = CapturingTransport(response=Response(200, {}, body))

    outcome = record_run([], transport=transport, **BASE)

    assert outcome.rejected_spans == 2
    assert outcome.error_message == "invalid OTLP span"
    assert outcome.ok is False


def test_full_success_returns_ok() -> None:
    transport = CapturingTransport(response=Response(200, {}, b'{"partialSuccess":{}}'))
    outcome = record_run([], transport=transport, **BASE)
    assert outcome.rejected_spans == 0
    assert outcome.error_message is None
    assert outcome.ok is True


def test_error_without_json_body_still_typed() -> None:
    # A gateway 401 with a non-JSON body (edge/ForwardAuth) must still map to a typed error.
    transport = CapturingTransport(response=Response(401, {}, b"Unauthorized"))
    with pytest.raises(TheoLensError) as excinfo:
        record_run([], transport=transport, **BASE)
    err: Any = excinfo.value
    assert err.status == 401
    assert err.code == "UNKNOWN"
    assert "Unauthorized" in err.message
