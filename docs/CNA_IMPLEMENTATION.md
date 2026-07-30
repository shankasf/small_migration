# CnA Readiness Implementation

Date: 22 July 2026. Implements the five work items agreed for the CnA process
(RBAC, config-gated HNZ models, OTEL telemetry, security scans, AI guardrails)
plus the admin portal (user management, token caps, usage/cost analytics,
security event visibility).

## 1. RBAC & user activity management

- Login is mandatory. Local email+password (bcrypt, 12 rounds; JWT HS256, 12 h
  expiry) is the default; **Entra ID is config-gated** (`AUTH_MODE=entra` +
  `ENTRA_TENANT_ID`/`ENTRA_AUDIENCE`): tokens are verified against the tenant
  JWKS and AD app-role/group claims map to application roles
  (`ENTRA_GROUP_ADMIN|ANALYST|AUDITOR`). No passwords are stored in Entra mode.
- Roles per the architecture doc §7.1: **admin** (everything, admin portal),
  **analyst** (own sessions only — row-level scoping on every session/file/
  output route), **auditor** (read-only audit/security views, no data access).
- Account status: `active` / `restricted` (read-only) / `disabled` (no login).
- Every action is written to the append-only `AuditEvent` table (who, what,
  when, decision, data class, severity, IP) and mirrored as an OTEL span event:
  logins (incl. failures), session create/update/delete, chat, uploads,
  downloads, permission denials, guardrail blocks, admin changes.
- WebSocket connections authenticate with the same JWT.
- Backend↔AI-service calls are authenticated with a shared `INTERNAL_API_KEY`.
- **Fail-closed by construction**: both services refuse to boot if
  `JWT_SECRET` (min 32 chars) or `INTERNAL_API_KEY` is missing, and the
  internal-auth guards reject requests with 503 rather than skipping auth if
  the key is somehow unset at runtime.
- First admin is seeded in local mode (`SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`)
  — change the password at first login.

## 2. HNZ / client models — config-gated

`ai-service/llm.py` + `config.py`. Switching the LLM to a client tenant is an
environment change only:

```
LLM_PROVIDER=azure
AZURE_OPENAI_ENDPOINT=https://<tenant>.openai.azure.com
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_API_VERSION=2024-10-21
AZURE_OPENAI_DEPLOYMENT=<deployment name>
```

Default remains `LLM_PROVIDER=openai` with `OPENAI_MODEL`. The provider/model
is carried through usage metering, pricing (`MODEL_PRICING` JSON env) and
telemetry attributes.

## 3. OTEL telemetry

- Backend: `@opentelemetry/sdk-node` + auto-instrumentation (http, express,
  pg), service name `circini-backend`. Audit events are attached as
  `audit.event` span events.
- AI service: tracer + meter, FastAPI instrumentation, service name
  `circini-ai-service`. Chat spans carry **gen_ai.& governance semantic
  conventions**: `gen_ai.system`, `gen_ai.request.model`,
  `gen_ai.usage.input_tokens/output_tokens`, `circini.guardrail.decision`,
  `circini.data_class`. Metrics: `gen_ai.client.token.usage`,
  `circini.guardrail.decisions`.
- Export is config-led: set `OTEL_EXPORTER_OTLP_ENDPOINT` to a collector
  (CloudWatch/Splunk/Sentinel exporters live in the collector, per §10);
  unset = spans recorded, nothing exported. `OTEL_ENABLED=false` disables.

## 4. Security scans (evidence)

Run 22 Jul 2026. Re-run with: `npm audit` (backend/, frontend/),
`python3 -m pip_audit -r ai-service/requirements.txt`,
`python3 -m bandit -r ai-service`.

| Scan | Before | After remediation | Remaining |
|---|---|---|---|
| npm audit backend | 13 (7 high) | **2** | `xlsx` high (no upstream fix — see below); `uuid` removed (unused) |
| npm audit frontend | 15 (7 high) | **5** | `vite`/`esbuild` (dev-server only, not shipped), `react-syntax-highlighter`→`prismjs` moderate (fix requires major upgrade) |
| pip-audit | starlette 6 CVEs | **0** | upgraded starlette 1.3.1 / fastapi 0.139; requirements pinned |
| bandit (ai-service) | 2 low/med | 1 accepted | B104 bind-all-interfaces is required inside the container; try/except-pass fixed |

`xlsx` (SheetJS npm 0.18.5, abandoned upstream): prototype-pollution/ReDoS
advisories, no npm fix. Mitigations in place: uploads are authenticated,
capped at 10 MB, extension-allowlisted and magic-byte-checked before parsing.
Recommended before production CnA: migrate to the maintained SheetJS CDN
distribution or `exceljs`.

## 5. AI guardrails (doc §9)

`ai-service/guardrails.py`, enforced server-side on every chat call, never
optional:

- **Inbound**: control-char sanitisation + size ceiling → prompt-injection
  heuristics (OWASP LLM01) → restricted-pattern deny-list → PII detection —
  NZ NHI (old + new format), IRD, email, NZ phone, DOB-in-context, and secret
  patterns (API keys, JWTs, private keys).
- **Mode A (default, `PHI_MODE=false`)**: health PII **blocks** the request
  outright (metadata-only posture). **Mode B (`PHI_MODE=true`)**: health PII
  is redacted and the request proceeds with full audit.
- All other PII/secrets are always redacted **before model egress**; the
  redacted payload is also what gets persisted to session storage.
- **Outbound**: the model response and generated files pass the same
  redaction filter before returning.
- Upload ingest (backend): extension allowlist per doc §5, magic-byte
  executable/container detection, 10 MB cap. (ClamAV/Presidio slot in behind
  the same interfaces for the production build.)
- Every decision returns to the backend and is audited
  (`guardrail.block` = critical severity) and counted in OTEL metrics.

## Admin portal

`/` → login → **Admin Portal** toggle (admins; auditors land there directly):

- **Overview**: tokens/cost/requests/active users, tokens-per-day chart,
  top users by month, usage by model. Cost from `MODEL_PRICING` (USD per 1M).
- **Users**: create users, change role/status (**disable / restrict**), set
  **daily & monthly token caps**, reset passwords. Caps are enforced at chat
  time (HTTP 429, audited). Self-lockout is prevented.
- **Security**: denial/guardrail-block counters and the full audit trail
  (filterable; "issues only" by default).

## Verified end-to-end (local)

Unauthenticated requests 401 · seeded admin login · analyst sees 0 of 65
legacy sessions, admin sees all · analyst denied admin API · NHI+DOB message
blocked (Mode A) with critical audit event · prompt injection blocked · email
redacted before egress on a live gpt-5.2 call and usage metered
(1,832 tokens / $0.0047) · daily cap 100 → HTTP 429 · disabled account login
403 · restricted account read-only · security summary and audit endpoints
return the expected events.

## Not yet done (deploy-time)

- k8s images not rebuilt/redeployed — the live cluster still runs the old
  build. Deploying needs new `INTERNAL_API_KEY`, `JWT_SECRET`, seed-admin
  secrets added to the k8s secret (do **not** run `deploy.sh` blindly; patch
  keys individually).
- OTel Collector not stood up (set `OTEL_EXPORTER_OTLP_ENDPOINT` when it is).
- Presidio/ClamAV swap-in and the frontend MSAL flow for `AUTH_MODE=entra`.
