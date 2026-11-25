# looptrace-sdk (Python)

A thin, **stdlib-only** Python client that records a Claude Code / [`@theokit/sdk`](https://getloopscale.com)
agent run to LoopTrace. It serializes the raw `SDKMessage` batch and POSTs it to the native
`POST /v1/runs` — the **engine** maps it to spans, so the client does **zero OTLP encoding** and has
**zero runtime dependencies** (`urllib` + `json` only).

## Install

```bash
pip install -e 'packages/sdk-py'          # from the repo
# dev tooling (pytest/ruff/mypy):
pip install -e 'packages/sdk-py[dev]'
```

## Usage

```python
from looptrace_sdk import record_run

messages = [
    {"type": "system", "subtype": "init", "agent_id": "demo", "run_id": "run-1", "model": "claude-opus-4-8"},
    {"type": "user", "agent_id": "demo", "run_id": "run-1",
     "message": {"role": "user", "content": [{"type": "text", "text": "What is 2+2?"}]}},
    {"type": "assistant", "agent_id": "demo", "run_id": "run-1",
     "message": {"role": "assistant", "content": [{"type": "text", "text": "4"}]}},
]
result = {"usage": {"inputTokens": 12, "outputTokens": 1}}

outcome = record_run(
    messages,
    result,
    base_url="https://app.getloopscale.com",   # your engine origin
    api_key="looptrace_live_...",              # a per-workspace key
)
print(outcome.ok, outcome.rejected_spans)
```

See [`examples/record_run_example.py`](./examples/record_run_example.py) for a ≤10-line runnable
script.

### Signature

```python
record_run(
    messages,                 # the SDKMessage batch (opaque JSON — never validated)
    result=None,              # optional terminal RunResult (usage/cost); omitted when None
    *,
    base_url,                 # engine origin, e.g. https://app.getloopscale.com
    api_key,                  # looptrace_live_* key → Authorization: Bearer
    base_path="/v1",          # "/v1" direct data API; "/v1/lens" for the unified edge
    start_time_ms=None,       # optional base epoch-ms; omitted when None
    timeout=30.0,
    transport=None,           # injectable HTTP seam (defaults to urllib)
) -> RecordRunResult
```

`RecordRunResult` exposes `.rejected_spans`, `.error_message`, and `.ok` (a `200` `partialSuccess`
with a rejected count is surfaced here, **not** raised).

### Through the unified edge

For edge consumers, swap the base path — everything else is identical:

```python
record_run(messages, base_url="https://app.getloopscale.com", api_key="looptrace_live_...", base_path="/v1/lens")
# → POST https://app.getloopscale.com/v1/lens/runs
```

## Errors

Every failure is a typed error under `LoopTraceBaseError`:

| Error | When |
|---|---|
| `LoopTraceError(status, code, message, retry_after=None)` | any non-2xx — `400 INVALID_BODY`, `413 PAYLOAD_TOO_LARGE`, `415 UNSUPPORTED_MEDIA_TYPE`, `429 RATE_LIMITED` (exposes `retry_after`), `401` (edge/auth) |
| `LoopTraceTransportError` | a network failure (DNS, connection reset, socket timeout) — **the run is never retried** (a run POST is billable and non-idempotent) |
| `LoopTraceSerializationError` | the payload is not JSON-serializable (raised before any I/O) |

A `429` surfaces `Retry-After` as `err.retry_after`; the client does **not** auto-retry — the caller
decides.

## Development

```bash
cd packages/sdk-py
pip install -e '.[dev]'
ruff check .
mypy .
python -m pytest
```

### Hermetic engine e2e (gated)

`tests/test_e2e_engine.py` POSTs all 18 shared vectors to a real engine and asserts `200`. It is
**skipped** unless both env vars are set:

```bash
LOOPTRACE_E2E_URL=http://localhost:4000 LOOPTRACE_E2E_KEY=looptrace_live_... \
  python -m pytest tests/test_e2e_engine.py
# optional: LOOPTRACE_E2E_BASE_PATH=/v1/lens to exercise the edge round-trip
```

## Cross-language contract

The Python serializer is pinned to the TS mapper by the committed
[`theokit-vectors.json`](../core/src/domain/theokit/theokit-vectors.json) — 18 documented behaviors
exported once from `MAPPER_VECTORS` and guarded against drift by `theokit-vectors-json.test.ts`.
`tests/test_vectors_contract.py` loads it so a divergence is a failing test, not a silent bug.
