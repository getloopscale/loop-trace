"""Typed error hierarchy for the LoopTrace ingest client.

Every failure at the client boundary is a specific, typed error carrying enough context to
diagnose without a debugger (``.claude/rules/error-handling.md`` §2) — the client never raises a
bare ``TypeError`` / ``URLError``. All three inherit ``LoopTraceBaseError`` so a caller can catch the
whole family with one ``except``.
"""

from __future__ import annotations


class LoopTraceBaseError(Exception):
    """Base class for every error raised by ``looptrace_sdk``."""


class LoopTraceError(LoopTraceBaseError):
    """A non-2xx response from the engine, carrying the parsed ``{code, message}`` envelope.

    ``status`` is the HTTP status; ``code`` the stable engine error code (e.g. ``PAYLOAD_TOO_LARGE``);
    ``retry_after`` the ``Retry-After`` seconds on a ``429`` (surfaced, never used to auto-retry).
    """

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        retry_after: int | None = None,
    ) -> None:
        super().__init__(f"[{status} {code}] {message}")
        self.status = status
        self.code = code
        self.message = message
        self.retry_after = retry_after


class LoopTraceTransportError(LoopTraceBaseError):
    """A network-level failure (DNS, connection reset, socket timeout) — no HTTP response arrived.

    A run POST is non-idempotent and billable, so an ambiguous timeout surfaces here and is NEVER
    silently retried (the M108 lesson).
    """


class LoopTraceSerializationError(LoopTraceBaseError):
    """The run payload could not be encoded to JSON (e.g. a ``set`` / ``datetime`` slipped in).

    Raised at the boundary BEFORE any I/O, so a non-serializable input fails fast and clear rather
    than as a bare ``TypeError`` deep in ``json.dumps``.
    """
