"""LoopTrace Python SDK — record a Claude Code / ``@theokit/sdk`` run to LoopTrace.

Public surface:

- :func:`record_run` — the single entrypoint (serialize a batch + POST to ``/v1/runs``).
- :class:`RecordRunResult` — the parsed ``partialSuccess`` outcome.
- The typed error hierarchy: :class:`LoopTraceError`, :class:`LoopTraceTransportError`,
  :class:`LoopTraceSerializationError` (all under :class:`LoopTraceBaseError`).
- :data:`SDKMessage` / :class:`RunResult` — the (documentation-only) type mirror.
"""

from __future__ import annotations

from .client import RecordRunResult, Response, Transport, record_run
from .errors import (
    LoopTraceBaseError,
    LoopTraceError,
    LoopTraceSerializationError,
    LoopTraceTransportError,
)
from .messages import RunResult, SDKMessage

__all__ = [
    "LoopTraceBaseError",
    "LoopTraceError",
    "LoopTraceSerializationError",
    "LoopTraceTransportError",
    "RecordRunResult",
    "Response",
    "RunResult",
    "SDKMessage",
    "Transport",
    "record_run",
]

__version__ = "0.1.0"
