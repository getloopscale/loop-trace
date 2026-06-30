#!/usr/bin/env bash
# M22 invariant-6 proof: cross-tenant isolation + fail-closed deny through a REAL
# Traefik ForwardAuth edge (hermetic — no theo-cloud). Brings up the edge overlay,
# asserts the contract end-to-end with curl, tears everything down.
#
#   pnpm test:e2e:edge        (or)  bash scripts/e2e-edge.sh
#
# Exit 0 = all assertions passed; non-zero = a contract violation (CI gate).
set -uo pipefail

COMPOSE="docker compose -f docker-compose.edge.yaml"
EDGE="http://localhost:${EDGE_TRAEFIK_PORT:-8095}"   # through Traefik
DIRECT="http://localhost:4319"                       # straight at the service (bypasses the edge)
FAILED=0

cleanup() { $COMPOSE down -v >/dev/null 2>&1 || true; }
trap cleanup EXIT

pass() { echo "  PASS  $1"; }
fail() { echo "  FAIL  $1"; FAILED=1; }

echo "== M22 edge e2e: bringing up hermetic Traefik ForwardAuth stack =="
$COMPOSE up -d --build >/dev/null 2>&1 || { echo "compose up failed"; $COMPOSE logs --tail 50; exit 2; }

# Wait for the edge to route to a live API (a no-key request returns 401 from the
# shim once everything is wired; a 502/000 means not-ready).
echo "== waiting for the edge to become ready =="
ready=0
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$EDGE/v1/traces" 2>/dev/null || echo 000)
  if [ "$code" = "401" ]; then ready=1; break; fi
  sleep 2
done
if [ "$ready" != "1" ]; then
  echo "edge did not become ready (last code: ${code:-?})"; $COMPOSE logs --tail 80; exit 2
fi

OTLP='{"resourceSpans":[{"scopeSpans":[{"spans":[{"spanId":"b-span","traceId":"b-trace","name":"op","startTimeUnixNano":"1700000000000000000","endTimeUnixNano":"1700000000100000000","attributes":[{"key":"input.value","value":{"stringValue":"bob canary"}}]}]}]}]}'

echo "== assertions =="

# 1) Tenant Bob writes a canary THROUGH the edge (customer key → minted bearer).
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$EDGE/v1/traces" \
  -H 'content-type: application/json' -H 'x-customer-key: cust_bob' -d "$OTLP")
[ "$code" = "200" ] && pass "bob writes through the edge (200)" || fail "bob write expected 200, got $code"

# 2) Tenant Alice reads through the edge → MUST NOT see Bob's trace (isolation).
a_body=$(curl -s "$EDGE/v1/traces" -H 'x-customer-key: cust_alice')
if echo "$a_body" | grep -q 'b-trace'; then
  fail "CROSS-TENANT LEAK — alice sees bob's trace: $a_body"
else
  pass "alice does NOT see bob's trace (cross-tenant isolation)"
fi

# 3) Tenant Bob reads through the edge → MUST see his own trace (path reaches data).
b_body=$(curl -s "$EDGE/v1/traces" -H 'x-customer-key: cust_bob')
echo "$b_body" | grep -q 'b-trace' && pass "bob sees his own trace" || fail "bob should see b-trace, got: $b_body"

# 4) No customer key → DENIED at the edge (401; the service is never reached).
code=$(curl -s -o /dev/null -w '%{http_code}' "$EDGE/v1/traces")
[ "$code" = "401" ] && pass "no-key request denied at the edge (401)" || fail "no-key expected 401, got $code"

# 5) The raw customer key sent DIRECTLY to the service is rejected — it only honors
#    minted theo_live_* keys (proves the edge MUST strip+mint; a leaked customer key
#    cannot authenticate against the data plane).
code=$(curl -s -o /dev/null -w '%{http_code}' "$DIRECT/v1/traces" -H 'authorization: Bearer cust_bob')
[ "$code" = "401" ] && pass "raw customer key rejected directly by the service (401)" || fail "direct customer key expected 401, got $code"

# 6) The customer-key HEADER sent directly (no Authorization) is also rejected — the
#    service never trusts X-Customer-Key (defense-in-depth; the edge owns that header).
code=$(curl -s -o /dev/null -w '%{http_code}' "$DIRECT/v1/traces" -H 'x-customer-key: cust_bob')
[ "$code" = "401" ] && pass "service ignores X-Customer-Key (401 without a bearer)" || fail "x-customer-key direct expected 401, got $code"

echo "== result =="
if [ "$FAILED" = "0" ]; then
  echo "EDGE_E2E_PASS — both CWE-441 halves proven through a real Traefik ForwardAuth edge"
  exit 0
else
  echo "EDGE_E2E_FAIL"
  $COMPOSE logs --tail 60
  exit 1
fi
