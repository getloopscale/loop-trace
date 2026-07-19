"""T3.1 — cross-language contract: the Python serializer agrees with all 18 shared vectors.

Loads the committed ``theokit-vectors.json`` (the language-neutral projection of the TS
``MAPPER_VECTORS``, guarded against drift by ``theokit-vectors-json.test.ts``) and asserts
``record_run`` serializes each vector's ``{messages, result?}`` into the exact batch the engine's
``/v1/runs`` accepts — no behavior is hand-mirrored into Python.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, cast

from theo_lens_sdk import record_run

from ._transport_stub import BASE, CapturingTransport

VECTORS_PATH = (
    Path(__file__).resolve().parents[2] / "core" / "src" / "domain" / "theokit" / "theokit-vectors.json"
)


def _load_vectors() -> list[dict[str, Any]]:
    return cast("list[dict[str, Any]]", json.loads(VECTORS_PATH.read_text(encoding="utf-8")))


def test_committed_vectors_json_has_18_entries() -> None:
    vectors = _load_vectors()
    assert len(vectors) == 18


def test_all_18_vectors_serialize_to_accepted_batch() -> None:
    vectors = _load_vectors()
    assert len(vectors) == 18
    for vector in vectors:
        transport = CapturingTransport()
        record_run(vector["messages"], vector.get("result"), transport=transport, **BASE)

        sent = transport.sent_json
        assert sent["messages"] == vector["messages"], vector["name"]
        if "result" in vector:
            assert sent["result"] == vector["result"], vector["name"]
        else:
            assert "result" not in sent, vector["name"]
