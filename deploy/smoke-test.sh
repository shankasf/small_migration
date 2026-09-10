#!/usr/bin/env bash
# Post-deploy smoke test. Asserts availability AND the security controls the
# CnA readiness section claims, against a running deployment.
#
# Usage:  deploy/smoke-test.sh [base-url]
# Exit 0 = all assertions held. Non-zero = a control regressed; roll back.

set -uo pipefail

BASE="${1:-https://migration.callsphere.site}"
CLUSTER="${ECS_CLUSTER:-circini-demo}"
SERVICES="${ECS_SERVICES:-frontend backend ai-service}"
PASS=0
FAIL=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s  (%s)\n' "$1" "$2"; FAIL=$((FAIL+1)); }

# Retries before failing: immediately after a rollout the ingress may still be
# routing to a terminating pod, which surfaces as a transient 502/503. Without
# this the smoke test reports a false failure and triggers a needless rollback.
RETRIES="${SMOKE_RETRIES:-10}"
RETRY_DELAY="${SMOKE_RETRY_DELAY:-3}"

expect_code() { # label url expected [curl args...]
  local label="$1" url="$2" want="$3"; shift 3
  local got attempt
  for attempt in $(seq 1 "$RETRIES"); do
    got=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "$@" "$url" 2>/dev/null)
    [ "$got" = "$want" ] && { ok "$label"; return; }
    # Only a gateway-level blip is worth retrying; a definite wrong answer
    # (e.g. 200 where 401 was required) is a real failure, so fail fast.
    case "$got" in
      502|503|504|000) sleep "$RETRY_DELAY" ;;
      *) break ;;
    esac
  done
  bad "$label" "want $want, got $got"
}

# Wait for the ingress to serve a ready backend before asserting anything.
printf '  waiting for endpoints to settle'
for _ in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$BASE/api/health" 2>/dev/null)
  [ "$code" = "200" ] && break
  printf '.'; sleep 3
done
echo

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

echo "== ai-service is not routed from the internet =="
# Under K3s, Traefik routed /ai to the ai-service and a 401 proved the internal
# key was enforced. On ECS the ai-service has no target group and no ALB rule
# at all - it is reachable only inside the VPC over Service Connect - so /ai/*
# must fall through to the SPA and never return an ai-service response.
for aipath in /ai/chat /ai/status/x; do
  aibody=$(curl -s --max-time 25 "$BASE$aipath" 2>/dev/null)
  if echo "$aibody" | grep -qE '"(output_dir|internal_auth)"[[:space:]]*:'; then
    bad "ai-service not routed ($aipath)" "ai-service response returned through the ALB"
  else
    ok "ai-service not routed ($aipath)"
  fi
done

echo "== transport =="
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 "http://${BASE#https://}/" 2>/dev/null)
case "$code" in 30[0-9]) ok "http redirects to https ($code)";; *) bad "http redirects to https" "got $code";; esac

echo "== container hardening =="
# Assertions read the live ECS task definitions. Gated on a describe call so
# the script still runs (skipping this section) without AWS credentials.
if command -v aws >/dev/null 2>&1 \
   && aws ecs describe-services --cluster "$CLUSTER" --services $SERVICES >/dev/null 2>&1; then

  tds=$(aws ecs describe-services --cluster "$CLUSTER" --services $SERVICES \
        --query 'services[].taskDefinition' --output text 2>/dev/null)

  # Images must be pinned to an immutable tag, never :latest. The ADOT
  # collector sidecar is vendor-published and exempt.
  imgs=$(for td in $tds; do
           aws ecs describe-task-definition --task-definition "$td" \
             --query "taskDefinition.containerDefinitions[?name!='otel-collector'].image" \
             --output text 2>/dev/null
         done)
  if echo "$imgs" | tr '\t' '\n' | grep -q ':latest'; then
    bad "images pinned (not :latest)" "$(echo "$imgs" | tr '\t' '\n' | grep ':latest' | tr '\n' ' ')"
  else
    ok "images pinned to immutable tags"
  fi

  # Application containers run on a read-only root filesystem.
  rw=""
  for td in $tds; do
    rw="$rw $(aws ecs describe-task-definition --task-definition "$td" \
      --query "taskDefinition.containerDefinitions[?name!='otel-collector' && name!='volume-init' && readonlyRootFilesystem!=\`true\`].name" \
      --output text 2>/dev/null)"
  done
  rw=$(echo "$rw" | tr -s ' ' | sed 's/^ //;s/ $//')
  [ -z "$rw" ] && ok "read-only root filesystem on all app containers" \
                || bad "read-only root filesystem" "writable: $rw"

  # Credentials must arrive via Secrets Manager, never as plaintext env vars.
  leaked=""
  for td in $tds; do
    leaked="$leaked $(aws ecs describe-task-definition --task-definition "$td" \
      --query "taskDefinition.containerDefinitions[].environment[?contains(name,'SECRET') || contains(name,'PASSWORD') || contains(name,'API_KEY')].name" \
      --output text 2>/dev/null)"
  done
  leaked=$(echo "$leaked" | tr -s ' ' | sed 's/^ //;s/ $//')
  [ -z "$leaked" ] && ok "no credentials in plaintext environment" \
                   || bad "no credentials in plaintext environment" "found: $leaked"
else
  echo "  (skipped: no aws CLI or cluster $CLUSTER not reachable)"
fi

echo
echo "passed: $PASS   failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
