# Minimal Theo Lens run recording. Run: THEO_LENS_URL=... THEO_LENS_KEY=theo_live_... python record_run_example.py
import os

from theo_lens_sdk import SDKMessage, record_run

MESSAGES: list[SDKMessage] = [
    {"type": "system", "subtype": "init", "agent_id": "demo", "run_id": "run-1", "model": "claude-opus-4-8"},
    {"type": "user", "agent_id": "demo", "run_id": "run-1", "message": {"role": "user", "content": [{"type": "text", "text": "What is 2+2?"}]}},
    {"type": "assistant", "agent_id": "demo", "run_id": "run-1", "message": {"role": "assistant", "content": [{"type": "text", "text": "4"}]}},
]
OUTCOME = record_run(MESSAGES, {"usage": {"inputTokens": 12, "outputTokens": 1}}, base_url=os.environ["THEO_LENS_URL"], api_key=os.environ["THEO_LENS_KEY"])
print("recorded" if OUTCOME.ok else f"partial: {OUTCOME.rejected_spans} rejected")
