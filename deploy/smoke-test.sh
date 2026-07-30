#!/usr/bin/env bash
# Post-deploy smoke test. Asserts availability AND the security controls the
# CnA readiness section claims, against a running deployment.
#
# Usage:  deploy/smoke-test.sh [base-url]
# Exit 0 = all assertions held. Non-zero = a control regressed; roll back.

set -uo pipefail

BASE="${1:-https://migration.callsphere.site}"
NS="${NAMESPACE:-migration-agent}"
PASS=0
FAIL=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s  (%s)\n' "$1" "$2"; FAIL=$((FAIL+1)); }

expect_code() { # label url expected [curl args...]
  local label="$1" url="$2" want="$3"; shift 3
  local got
  got=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$@" "$url" 2>/dev/null)
  [ "$got" = "$want" ] && ok "$label" || bad "$label" "want $want, got $got"
}

echo "== availability =="
expect_code "frontend serves"            "$BASE/"             200
expect_code "backend health"             "$BASE/api/health"   200
expect_code "ai-service health"          "$BASE/ai/health"    200

echo "== authentication is enforced =="
expect_code "sessions rejects anonymous" "$BASE/api/sessions"      401
expect_code "admin rejects anonymous"    "$BASE/api/admin/users"   401
expect_code "audit rejects anonymous"    "$BASE/api/admin/audit"   401
expect_code "stt rejects anonymous"      "$BASE/api/stt"           401 -X POST
expect_code "bad token rejected"         "$BASE/api/sessions"      401 -H 'Authorization: Bearer not-a-real-token'
expect_code "bare Bearer rejected"       "$BASE/api/sessions"      401 -H 'Authorization: Bearer '

echo "== no public-path bypass =="
# Only exact matches are public; near-misses must NOT fall through.
# 401 (not 404) is the correct answer: auth fires before routing, proving the
# near-miss path was never treated as public.
expect_code "health prefix is not public"  "$BASE/api/healthcheck"        401
expect_code "internal ns is not public"    "$BASE/api/internal/anything"  401
expect_code "logs needs internal key"      "$BASE/api/logs/x"             401 -X POST -H 'Content-Type: application/json' -d '{}'
expect_code "logs rejects wrong key"       "$BASE/api/logs/x"             401 -X POST -H 'Content-Type: application/json' -H 'x-internal-key: wrong' -d '{}'

echo "== ai-service is not reachable with a user token =="
expect_code "ai chat needs internal key"  "$BASE/ai/chat"    401 -X POST -H 'Content-Type: application/json' -d '{}'
expect_code "ai status needs internal key" "$BASE/ai/status/x" 401

echo "== transport =="
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "http://${BASE#https://}/" 2>/dev/null)
case "$code" in 30[0-9]) ok "http redirects to https ($code)";; *) bad "http redirects to https" "got $code";; esac

echo "== container hardening =="
# Probe with a namespaced read: the CD ServiceAccount is scoped to this
# namespace and cannot 'get namespaces', so gating on that would silently skip
# every assertion below.
if command -v kubectl >/dev/null 2>&1 && kubectl get deploy -n "$NS" >/dev/null 2>&1; then
  # No source is mounted from the host — the image is the only code source.
  hp=$(kubectl get deploy -n "$NS" -o jsonpath='{range .items[*]}{.spec.template.spec.volumes[*].hostPath.path}{"\n"}{end}' 2>/dev/null | tr -d '\n')
  [ -z "$hp" ] && ok "no hostPath mounts in any deployment" || bad "no hostPath mounts" "found: $hp"

  # Images must be pinned to an immutable tag, never :latest.
  imgs=$(kubectl get deploy -n "$NS" -o jsonpath='{range .items[*]}{.spec.template.spec.containers[*].image}{"\n"}{end}' 2>/dev/null)
  if echo "$imgs" | grep -q ':latest'; then
    bad "images pinned (not :latest)" "$(echo "$imgs" | grep ':latest' | tr '\n' ' ')"
  else
    ok "images pinned to immutable tags"
  fi

  # Outputs volume must stay writable — blocking it would break the product.
  if kubectl exec -n "$NS" deployment/ai-service -- sh -c 'touch /data/outputs/.smoke && rm -f /data/outputs/.smoke' >/dev/null 2>&1; then
    ok "outputs volume writable"
  else
    bad "outputs volume writable" "write failed"
  fi
else
  echo "  (skipped: no kubectl or namespace $NS not reachable)"
fi

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
