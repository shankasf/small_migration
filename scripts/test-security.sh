#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -z "${TEST_DATABASE_URL:-}" ]]; then
  echo 'Set TEST_DATABASE_URL to an isolated localhost migration_security_test database.' >&2
  exit 1
fi
export DATABASE_URL="$TEST_DATABASE_URL"
export AUTH_MODE=local JWT_SECRET=synthetic-security-test-signing-secret-minimum-32-chars
export INTERNAL_API_KEY=synthetic-internal-test-key TEST_POLICY_PORT=58439
export AI_SERVICE_URL=http://127.0.0.1:58439
unset AUDIT_ARCHIVE_BUCKET AUDIT_ARCHIVE_REQUIRED RETENTION_DELETE_ENABLED
cd services/backend
node -e 'const u=new URL(process.env.DATABASE_URL); if (!["localhost","127.0.0.1"].includes(u.hostname)||u.pathname!=="/migration_security_test")process.exit(1)'
./node_modules/.bin/prisma db push --skip-generate
node --import tsx --test tests/security.test.ts
