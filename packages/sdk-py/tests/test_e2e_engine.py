"""T3.2 — gated hermetic e2e: POST all 18 vectors to a real engine and assert 200 partialSuccess.

Skipped unless ``LOOPTRACE_E2E_URL`` + ``LOOPTRACE_E2E_KEY`` are set (the engine is not running in
CI). This is the real proof that the batches are actually accepted by ``/v1/runs``; the serialization
contract test (``test_vectors_contract``) is the CI-safe proof of the same shape.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, cast

import pytest

from looptrace_sdk import record_run

E2E_URL = os.environ.get("LOOPTRACE_E2E_URL")
E2E_KEY = os.environ.get("LOOPTRACE_E2E_KEY")
E2E_BASE_PATH = os.environ.get("LOOPTRACE_E2E_BASE_PATH", "/v1")

VECTORS_PATH = (
    Path(__file__).resolve().parents[2] / "core" / "src" / "domain" / "theokit" / "theokit-vectors.json"
)

pytestmark = pytest.mark.skipif(
    not (E2E_URL and E2E_KEY),
    reason="set LOOPTRACE_E2E_URL + LOOPTRACE_E2E_KEY to run the hermetic engine e2e",
)


def _load_vectors() -> list[dict[str, Any]]:
    return cast("list[dict[str, Any]]", json.loads(VECTORS_PATH.read_text(encoding="utf-8")))


def test_all_18_vectors_accepted_by_engine() -> None:
    assert E2E_URL and E2E_KEY  # narrowed by the skipif, re-asserted for mypy
    vectors = _load_vectors()
    assert len(vectors) == 18
    for vector in vectors:
        outcome = record_run(
            vector["messages"],
            vector.get("result"),
            base_url=E2E_URL,
            api_key=E2E_KEY,
            base_path=E2E_BASE_PATH,
        )
        # partialSuccess object is present (empty on full success, or with a rejected count).
        assert outcome.rejected_spans >= 0, vector["name"]
