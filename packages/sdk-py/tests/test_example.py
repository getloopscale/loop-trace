"""T4.2 — the runnable example is a ≤10-line record_run call."""

from __future__ import annotations

from pathlib import Path

EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "record_run_example.py"


def _code_lines(text: str) -> list[str]:
    return [line for line in text.splitlines() if line.strip() and not line.strip().startswith("#")]


def test_example_is_at_most_ten_lines_of_code() -> None:
    text = EXAMPLE.read_text(encoding="utf-8")
    lines = _code_lines(text)
    assert len(lines) <= 10, f"example has {len(lines)} code lines"


def test_example_imports_and_calls_record_run() -> None:
    text = EXAMPLE.read_text(encoding="utf-8")
    assert "from looptrace_sdk import" in text
    assert "record_run(" in text
