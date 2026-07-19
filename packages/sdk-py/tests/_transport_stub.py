"""Test doubles for the injectable HTTP transport seam (no real network in the unit tier)."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, TypedDict

from theo_lens_sdk.client import Response


class Base(TypedDict):
    """The shared ``base_url`` + ``api_key`` kwargs (typed so ``**BASE`` unpacks under mypy strict)."""

    base_url: str
    api_key: str


BASE: Base = {"base_url": "http://engine.test", "api_key": "theo_live_x"}


@dataclass
class CapturingTransport:
    """Records every call and returns a canned response (default: ``200 {partialSuccess: {}}``)."""

    response: Response = field(default_factory=lambda: Response(200, {}, b'{"partialSuccess": {}}'))
    calls: list[dict[str, Any]] = field(default_factory=list)

    def __call__(
        self,
        *,
        url: str,
        method: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout: float,
    ) -> Response:
        self.calls.append(
            {"url": url, "method": method, "headers": dict(headers), "body": body, "timeout": timeout}
        )
        return self.response

    @property
    def last(self) -> dict[str, Any]:
        return self.calls[-1]

    @property
    def sent_json(self) -> Any:
        return json.loads(self.last["body"])


@dataclass
class RaisingTransport:
    """Raises a supplied exception on every call and counts invocations (proves no-retry)."""

    exc: BaseException
    calls: int = 0

    def __call__(
        self,
        *,
        url: str,
        method: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout: float,
    ) -> Response:
        self.calls += 1
        raise self.exc
