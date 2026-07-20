#!/usr/bin/env bash
# theo-instrument-claude — print the env recipe that points Claude Code's OTLP
# trace export at a Theo Lens endpoint (M15). Traces-only: metrics + logs are
# disabled because Theo Lens ingests spans, not metrics/logs.
#
# Usage:
#   # Local stack (single-tenant, no edge):
#   eval "$(scripts/theo-instrument-claude.sh [endpoint])"
#
#   # M50 — platform edge (per-tenant, multi-tenant): pass your `theo_live_*`
#   # platform key as the 2nd arg. Traces route through the unified `/v1/lens`
#   # edge (Traefik forward-auth-lens gates + lens-rewrite `/v1/lens/*` → `/v1/*`),
#   # so Claude Code's spans reach theo-lens isolated to YOUR workspace and the
#   # customer key is swapped for a per-tenant key at the edge (Model-B) — the
#   # key never reaches theo-lens's origin.
#   eval "$(scripts/theo-instrument-claude.sh https://app-dev.usetheo.dev theo_live_xxx)"
#
# endpoint defaults to http://localhost:4318 (the local one-command stack). In
# local mode the OTLP/HTTP traces path /v1/traces is appended; in edge mode
# (a key is given) the path is /v1/lens/traces (the edge rewrites it to /v1/traces).
#
# NOTE: Claude Code trace export is BETA (CLAUDE_CODE_ENHANCED_TELEMETRY_BETA) — the
# span schema may change. Spans carry user.email / user.id / account_uuid and, with
# OTEL_LOG_USER_PROMPTS=1, the prompt text — send only to a Theo Lens you trust.
set -euo pipefail

ENDPOINT="${1:-http://localhost:4318}"
KEY="${2:-}"

# Local mode (no key): raw /v1/traces on the given endpoint, no auth header.
TRACES_PATH="/v1/traces"
AUTH_LINE=""

if [ -n "$KEY" ]; then
  # M50 edge mode. Fail-fast: only a Theo platform key (`theo_live_*`) is valid
  # — the edge fail-closes on anything else, so refuse it here with a clear
  # message rather than emitting a recipe that will 401 at ingest time.
  case "$KEY" in
    theo_live_*) : ;;
    # SECURITY (M50 review LOW): show only a fixed-length prefix, NEVER a
    # delimiter-based truncation — a rejected key without an underscore (e.g. an
    # OpenAI `sk-...` fat-fingered into arg 2) would otherwise echo the FULL
    # secret to stderr via `${KEY%%_*}`.
    *) echo "theo-instrument-claude: key must be a Theo platform key (theo_live_*), got '${KEY:0:8}…'" >&2; exit 1 ;;
  esac
  TRACES_PATH="/v1/lens/traces"
  AUTH_LINE="export OTEL_EXPORTER_OTLP_HEADERS=\"Authorization=Bearer ${KEY}\""
fi

cat <<EOF
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1
export OTEL_TRACES_EXPORTER=otlp
export OTEL_METRICS_EXPORTER=none
export OTEL_LOGS_EXPORTER=none
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${ENDPOINT}${TRACES_PATH}
export OTEL_TRACES_EXPORT_INTERVAL=1000
EOF
if [ -n "$AUTH_LINE" ]; then
  echo "$AUTH_LINE"
fi
