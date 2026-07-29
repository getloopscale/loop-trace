#!/usr/bin/env bash
# Dev deploy — runs ON the dev host, invoked by publish.yml's deploy-dev job over SSH after a
# fresh image lands on GHCR. The workflow syncs this checkout to the published commit and logs
# into GHCR *before* calling this script; here we only pull and (re)start the API.
#
# Postgres is deliberately left alone: it holds real data and outlives any deploy. It is brought
# up in the same command only so compose keeps all services on one network — a failed recreate
# that detaches the API from the DB network is a documented failure mode from theo-rag's pipeline.
#
# Exits non-zero unless BOTH gates pass, because a deploy that reports success without proving
# the new code is serving is worse than one that fails: it retires the question.
set -euo pipefail

PORT="${THEOLENS_API_PORT:-18084}"
COMPOSE=(docker compose -f docker-compose.yaml -f docker-compose.deploy.yml)

cd "$(dirname "$0")/.."

"${COMPOSE[@]}" pull api
"${COMPOSE[@]}" up -d postgres api

# ── Gate 1: version ──────────────────────────────────────────────────────────────────────────
# Assert the RUNNING image is the exact commit deployed. The sha is stamped into the image at
# build as an OCI label, so this catches the two failures a health check cannot see: a stale
# `:develop` pull, and a container that never recreated. Both leave a green, healthy, WRONG API.
#
# Why not GET /v1/version: that reads the deploy-time .env, so it proves the container restarted
# with the right config — a wrong image with a right .env would still pass. The label is baked
# into the image itself.
EXPECTED_SHA="${EXPECTED_SHA:-$(git rev-parse HEAD)}"
RUNNING_SHA="$(docker inspect theolens_api \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)"

if [ "$RUNNING_SHA" != "$EXPECTED_SHA" ]; then
  echo "deploy FAILED — running api image revision '${RUNNING_SHA}' != expected '${EXPECTED_SHA}'" >&2
  echo "  (a stale :develop image was pulled, or the container did not recreate)" >&2
  "${COMPOSE[@]}" ps api || true
  exit 1
fi
echo "version verified — api running image revision ${RUNNING_SHA}"

# ── Gate 2: health ───────────────────────────────────────────────────────────────────────────
# Liveness AND readiness. Gating on readiness means a deploy that cannot reach Postgres is
# reported failed rather than silently green — the API would be up and answering 503 to every
# real request, which is the shape of an outage nobody is paged for.
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/v1/healthz" >/dev/null 2>&1 \
    && curl -fsS "http://127.0.0.1:${PORT}/v1/healthz/ready" >/dev/null 2>&1; then
    echo "deploy ok — /v1/healthz + /v1/healthz/ready green on :${PORT}"
    "${COMPOSE[@]}" ps api
    exit 0
  fi
  sleep 2
done

echo "deploy FAILED — liveness/readiness not green after 60s" >&2
"${COMPOSE[@]}" logs --tail=50 api || true
exit 1
