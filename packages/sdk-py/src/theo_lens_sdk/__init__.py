"""Theo Lens Python SDK — record a Claude Code / ``@theokit/sdk`` run to Theo Lens.

Public surface:

- :func:`record_run` — the single entrypoint (serialize a batch + POST to ``/v1/runs``).
- :class:`RecordRunResult` — the parsed ``partialSuccess`` outcome.
- The typed error hierarchy: :class:`TheoLensError`, :class:`TheoLensTransportError`,
  :class:`TheoLensSerializationError` (all under :class:`TheoLensBaseError`).
- :data:`SDKMessage` / :class:`RunResult` — the (documentation-only) type mirror.
"""

from __future__ import annotations

from .client import RecordRunResult, Response, Transport, record_run
from .errors import (
    TheoLensBaseError,
    TheoLensError,
    TheoLensSerializationError,
    TheoLensTransportError,
)
from .messages import RunResult, SDKMessage

__all__ = [
    "RecordRunResult",
    "Response",
    "RunResult",
    "SDKMessage",
    "TheoLensBaseError",
    "TheoLensError",
    "TheoLensSerializationError",
    "TheoLensTransportError",
    "Transport",
    "record_run",
]

__version__ = "0.1.0"
