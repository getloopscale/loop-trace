#!/usr/bin/env bash
# theo-instrument-claude — print the env recipe that points Claude Code's OTLP
# trace export at a Theo Lens endpoint (M15). Traces-only: metrics + logs are
# disabled because Theo Lens ingests spans, not metrics/logs.
#
# Usage:
#   eval "$(scripts/theo-instrument-claude.sh [endpoint])"   # set in current shell
#   scripts/theo-instrument-claude.sh                         # just print the recipe
#
# endpoint defaults to http://localhost:4318 (the local one-command stack). The
# OTLP/HTTP traces path /v1/traces is appended automatically.
#
# NOTE: Claude Code trace export is BETA (CLAUDE_CODE_ENHANCED_TELEMETRY_BETA) — the
# span schema may change. Spans carry user.email / user.id / account_uuid and, with
# OTEL_LOG_USER_PROMPTS=1, the prompt text — send only to a Theo Lens you trust.
set -euo pipefail

ENDPOINT="${1:-http://localhost:4318}"

cat <<EOF
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
export OTEL_TRACES_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=none
export OTEL_LOGS_EXPORTER=none
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${ENDPOINT}/v1/traces
export OTEL_TRACES_EXPORT_INTERVAL=1000
EOF
