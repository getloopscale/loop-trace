"""``record_run`` — serialize an ``SDKMessage`` batch and POST it to the native ``/v1/runs``.

Stdlib-only (``urllib.request`` + ``json``, ADR D2). The client performs ZERO OTLP encoding — it
serializes ``{messages, result?, startTimeMs?}`` faithfully and speaks the engine's error envelope.
A billable run POST is non-idempotent and is NEVER retried on an ambiguous timeout (M108).
"""

from __future__ import annotations

import http.client
import json
import urllib.error
import urllib.request
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from .errors import (
    LoopTraceError,
    LoopTraceSerializationError,
    LoopTraceTransportError,
)
from .messages import RunResult, SDKMessage

DEFAULT_TIMEOUT_SECONDS = 30.0


@dataclass(frozen=True)
class Response:
    """A raw HTTP response handed back by a :data:`Transport` (2xx or non-2xx alike)."""

    status: int
    headers: Mapping[str, str]
    body: bytes


class Transport(Protocol):  # pragma: no cover - structural type only
    """The injectable HTTP seam. The default is :func:`urllib_transport`; tests pass a stub.

    A transport returns a :class:`Response` for ANY HTTP status (mapping non-2xx to a typed error is
    ``record_run``'s job) and raises :class:`~looptrace_sdk.errors.LoopTraceTransportError` only when
    no response arrives (network failure).
    """

    def __call__(
        self,
        *,
        url: str,
        method: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout: float,
    ) -> Response: ...


@dataclass(frozen=True)
class RecordRunResult:
    """The parsed ``200 {partialSuccess}`` outcome.

    ``rejected_spans`` is ``0`` on full success; a positive count (with ``error_message``) means the
    engine accepted the run but dropped some spans — surfaced, never raised.
    """

    rejected_spans: int = 0
    error_message: str | None = None

    @property
    def ok(self) -> bool:
        """True when every span was accepted."""
        return self.rejected_spans == 0


def urllib_transport(
    *,
    url: str,
    method: str,
    headers: Mapping[str, str],
    body: bytes,
    timeout: float,
) -> Response:
    """Default stdlib transport. Non-2xx arrives as :class:`urllib.error.HTTPError` — a real
    response — so it is handed back for status→error mapping; a genuine network failure (an
    ``OSError``: ``URLError`` / ``TimeoutError`` / connection reset) becomes a transport error."""
    request = urllib.request.Request(url, data=body, headers=dict(headers), method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:
            return Response(status=resp.status, headers=_normalize_headers(resp.headers), body=resp.read())
    except urllib.error.HTTPError as exc:
        return Response(status=exc.code, headers=_normalize_headers(exc.headers), body=exc.read())
    except OSError as exc:  # URLError, TimeoutError, ConnectionResetError all subclass OSError
        raise LoopTraceTransportError(f"transport failure POSTing to {url}: {exc}") from exc
    except http.client.HTTPException as exc:
        # #66 — a truncated body raises http.client.IncompleteRead (an HTTPException, NOT an OSError) from
        # resp.read(); honor the typed-error boundary instead of leaking the bare stdlib exception.
        raise LoopTraceTransportError(f"transport failure reading response from {url}: {exc}") from exc


def record_run(
    messages: Sequence[SDKMessage],
    result: RunResult | None = None,
    *,
    base_url: str,
    api_key: str,
    base_path: str = "/v1",
    start_time_ms: int | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    transport: Transport | None = None,
) -> RecordRunResult:
    """Record an agent run: serialize the batch and POST it to ``{base_url}{base_path}/runs``.

    Args:
        messages: the ``SDKMessage`` batch (opaque JSON — never validated).
        result: the terminal ``RunResult`` (usage/cost); omitted from the body when ``None``.
        base_url: the engine origin, e.g. ``https://app.getloopscale.com`` or ``http://localhost:4000``.
        api_key: a ``looptrace_live_*`` key sent as ``Authorization: Bearer``.
        base_path: ``/v1`` for the direct data API, ``/v1/lens`` for the unified edge.
        start_time_ms: optional base epoch-ms; omitted from the body when ``None``.
        timeout: per-request timeout in seconds.
        transport: an injectable HTTP seam (defaults to :func:`urllib_transport`).

    Returns:
        A :class:`RecordRunResult` on any 2xx.

    Raises:
        LoopTraceSerializationError: the payload is not JSON-serializable (before any I/O).
        LoopTraceError: the engine returned a non-2xx (carries ``status`` + parsed ``code``/``message``).
        LoopTraceTransportError: a network failure — the run is NOT retried.
    """
    payload: dict[str, Any] = {"messages": messages}
    if result is not None:
        payload["result"] = result
    if start_time_ms is not None:
        payload["startTimeMs"] = start_time_ms

    try:
        body = json.dumps(payload).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise LoopTraceSerializationError(f"run payload is not JSON-serializable: {exc}") from exc

    url = f"{base_url}{base_path}/runs"
    headers = {"authorization": f"Bearer {api_key}", "content-type": "application/json"}
    send = transport if transport is not None else urllib_transport

    response = send(url=url, method="POST", headers=headers, body=body, timeout=timeout)

    if 200 <= response.status < 300:
        return _parse_success(response)
    raise _to_error(response)


# ---------------------------------------------------------------------------
# Response parsing (private)
# ---------------------------------------------------------------------------


def _parse_success(response: Response) -> RecordRunResult:
    data = _parse_json_body(response.body)
    partial = data.get("partialSuccess") if isinstance(data, dict) else None
    if not isinstance(partial, dict):
        return RecordRunResult()
    rejected = partial.get("rejectedSpans")
    error_message = partial.get("errorMessage")
    return RecordRunResult(
        rejected_spans=rejected if isinstance(rejected, int) and not isinstance(rejected, bool) else 0,
        error_message=error_message if isinstance(error_message, str) else None,
    )


def _to_error(response: Response) -> LoopTraceError:
    data = _parse_json_body(response.body)
    code = data.get("code") if isinstance(data, dict) else None
    message = data.get("message") if isinstance(data, dict) else None
    retry_after = _parse_retry_after(response.headers) if response.status == 429 else None
    return LoopTraceError(
        status=response.status,
        code=code if isinstance(code, str) else "UNKNOWN",
        message=message if isinstance(message, str) else (_decode(response.body) or "request failed"),
        retry_after=retry_after,
    )


def _parse_json_body(body: bytes) -> Any:
    try:
        return json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return {}


def _decode(body: bytes) -> str:
    return body.decode("utf-8", "replace").strip()[:500]


def _normalize_headers(headers: Any) -> dict[str, str]:
    if headers is None:
        return {}
    return {str(k): str(v) for k, v in headers.items()}


def _parse_retry_after(headers: Mapping[str, str]) -> int | None:
    for key, value in headers.items():
        if key.lower() == "retry-after":
            try:
                return int(value)
            except (TypeError, ValueError):
                return None
    return None
