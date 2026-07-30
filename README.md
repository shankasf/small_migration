# Circini Migration Agent

AI-powered DBT/SQL data migration assistant with a ChatGPT-like interface for analyzing mapping documents and generating Snowflake-compatible DBT models.

## Tech Stack

- **Frontend**: React 18, Vite, TypeScript, TailwindCSS, Socket.IO client, React Markdown, React Syntax Highlighter
- **Backend**: Node.js, Express, TypeScript, Prisma, PostgreSQL, Socket.IO, Multer (file uploads)
- **AI Service**: Python, FastAPI, OpenAI Agents SDK, OpenAI Whisper (speech-to-text via `gpt-4o-transcribe`)
- **Database**: PostgreSQL
- **Deployment**: Kubernetes (K3s), Docker, Traefik, cert-manager

## Architecture

```mermaid
flowchart LR
    U["🖥️ Browser<br/>React + Vite"]

    subgraph edge["Edge — TLS termination"]
        IG["Traefik ingress<br/>migration.callsphere.site<br/>cert-manager · Let's Encrypt"]
    end

    subgraph cluster["K3s cluster — namespace: migration-agent"]
        FE["frontend :5173<br/>React 18 · Vite · Tailwind"]
        BE["backend :3001<br/>Express · Prisma · Socket.IO<br/>🔐 JWT + RBAC"]
        AI["ai-service :8084<br/>FastAPI · Agents SDK<br/>🔐 x-internal-key"]
        DB[("PostgreSQL<br/>users · sessions · messages<br/>audit_events · usage_records")]
        PV[("outputs PVC<br/>/data/outputs")]
    end

    OAI["☁️ OpenAI API<br/>chat + Whisper"]

    U -- HTTPS --> IG
    IG -- "/" --> FE
    IG -- "/api" --> BE
    IG -- "/ai" --> AI
    BE <-- "Prisma" --> DB
    BE -- "x-internal-key" --> AI
    AI -- "logs: x-internal-key" --> BE
    BE -. "Socket.IO<br/>live logs" .-> U
    AI -- "generated SQL" --> PV
    AI -- "TLS" --> OAI

    classDef svc fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    classDef data fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef ext fill:#fef3c7,stroke:#d97706,stroke-width:2px,color:#0f172a
    classDef client fill:#f3e8ff,stroke:#9333ea,stroke-width:2px,color:#0f172a
    class FE,BE,AI svc
    class DB,PV data
    class OAI,IG ext
    class U client
```

Both `/api` and `/ai` are reachable at the edge. `/api` requires a user JWT;
`/ai` is guarded by a **fail-closed** shared-secret middleware — an unset
`INTERNAL_API_KEY` returns `503` rather than skipping the check, and a missing
or wrong key returns `401`. The AI service is never reachable with a user token
alone.

## Features

- **Chat Interface**: ChatGPT-style UI with persistent conversation history stored in PostgreSQL
- **Session Management**: Create, switch, search, rename, and delete chat sessions with a resizable sidebar
- **File Upload**: Attach up to 10 files per message (CSV, XLSX, SQL, JSON, YAML, TXT, XML, MD, PY, JS, TS, LOG)
- **Voice Input**: Record audio in the browser, transcribed server-side via OpenAI Whisper (`gpt-4o-transcribe`)
- **AI Migration Agent**: Analyzes template and mapping documents, then generates Snowflake-compatible DBT SQL models using the OpenAI Agents SDK
- **Realtime Logs**: Live status updates streamed from the AI service to the frontend via Socket.IO during processing
- **File Downloads**: Export generated SQL output files directly from chat messages
- **Session TTL**: In-memory agent sessions auto-evict after 1 hour of inactivity (max 50 concurrent)
- **File Re-hydration**: Session files are automatically reloaded from the database when resuming a conversation
- **Access Control**: Email/password or Microsoft Entra ID sign-in, three roles, per-user token budgets
- **Audit Trail**: Every auth, authorisation, chat and file action recorded with a PII-scrubbed detail payload
- **Guardrails**: Health-PII and secret detection on the way in, redaction on the way out

## Security

### Authentication and authorisation

Every request passes four gates in order. A request that clears gate 1 skips
straight to the handler; any other failure is denied and audited.

| # | Gate | What it checks | On failure |
|---|---|---|---|
| 1 | **Public path** | Exact-match allowlist only — `/api/health`, `/api/auth/login`. No prefix matching, so nothing falls through by resembling a public route. | — (passes to handler) |
| 2 | **Valid token** | `local`: HS256 JWT, issuer `circini-backend` (startup fails if the secret is under 32 chars). `entra`: verified against the tenant JWKS, with app-roles / AD groups mapped to a role. | `401` |
| 3 | **Account enabled** | `disabled` is refused outright; `restricted` keeps read access but loses writes. | `403` + audit |
| 4 | **Role allows route** | `requireRole(...)` gates admin and auditor routes; `requireWriteAccess` blocks auditors and restricted accounts from any write. | `403` + audit |

Gates 2–4 are re-evaluated on **every** request, not just at login — revoking a
role or disabling an account takes effect on the user's next action rather than
when their token expires.

Service-to-service routes are **registered ahead of** the user-auth middleware
and carry their own fail-closed `requireInternalKey` guard. There is no path
prefix exemption inside `authenticate`, so a newly added route cannot silently
inherit an auth bypass.

### Roles

| Capability | `admin` | `analyst` | `auditor` |
|---|:--:|:--:|:--:|
| Own chat sessions, upload, generate | ✅ | ✅ | ❌ |
| See **all** sessions | ✅ | own only | ❌ |
| Manage users, set token budgets | ✅ | ❌ | ❌ |
| Read audit log and security summary | ✅ | ❌ | ✅ |

A `restricted` status revokes write access without disabling the account;
`disabled` blocks sign-in outright. Sessions created before auth existed have no
owner and are admin-only.

### Chat request lifecycle

Every control below is enforced **server-side**. The browser is never trusted.

```mermaid
sequenceDiagram
    autonumber
    participant U as Browser
    participant B as backend
    participant D as PostgreSQL
    participant A as ai-service
    participant O as OpenAI

    U->>B: POST /api/chat/:id/messages<br/>Authorization: Bearer JWT
    B->>B: authenticate → user, status
    B->>B: requireWriteAccess<br/>(auditor / restricted → 403)
    B->>D: load session + files
    B->>B: canAccessSession<br/>(not owner & not admin → 403 + audit)
    B->>D: checkTokenCaps<br/>(over daily/monthly → 429 + audit)

    B->>A: POST /ai/chat + x-internal-key
    A->>A: guardrails.check_inbound<br/>secrets · health-PII · injection
    alt blocked (PHI mode A)
        A-->>B: blocked + reason
        B->>D: audit guardrail.block
        B-->>U: refusal, no model call
    else allowed or redacted
        A->>O: prompt (redacted payload)
        O-->>A: response + tool calls
        A->>A: generate_output → _safe_join<br/>allowlisted filename only
        A->>A: guardrails outbound redaction
        A-->>B: response + usage
        B->>D: recordUsage + recordAudit
        B-->>U: reply, generated files
    end
```

### Defence in depth

```mermaid
flowchart TD
    L1["🌐 Edge<br/>TLS via cert-manager · HTTP→HTTPS redirect · CORS allowlist"]
    L2["🔐 Identity<br/>JWT (HS256, ≥32-char secret) or Entra ID JWKS<br/>startup fails on a weak secret"]
    L3["👤 Authorisation<br/>role guards · write guard · per-row session ownership"]
    L4["📊 Quota<br/>per-user daily and monthly token caps → 429"]
    L5["🛡️ Guardrails<br/>inbound secret + health-PII detection · outbound redaction"]
    L6["📁 Filesystem<br/>allowlisted output names · resolved-parent check<br/>read-only source mounts"]
    L7["📝 Audit<br/>every allow/deny recorded with PII-scrubbed detail"]

    L1 --> L2 --> L3 --> L4 --> L5 --> L6 --> L7

    classDef layer fill:#e0e7ff,stroke:#4f46e5,stroke-width:2px,color:#0f172a
    class L1,L2,L3,L4,L5,L6,L7 layer
```

### Secrets

`DATABASE_URL`, `OPENAI_API_KEY`, `JWT_SECRET`, `INTERNAL_API_KEY`,
`SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` live in the
`migration-agent-secret` Kubernetes Secret and reach pods via `secretKeyRef` —
never baked into images or manifests. `.env` is gitignored and no longer mounted
into pods.

The initial admin is seeded **only** when no admin exists and
`SEED_ADMIN_PASSWORD` is at least 12 characters. There is no default password:
without a valid one the seed is skipped with a loud error rather than creating a
known-credential account.

> [!NOTE]
> **Deployment is pipeline-only.** Production runs immutable images pinned per
> commit; nothing is mounted from the host and no watcher reloads code in place.
> Push to `main` and the pipeline builds, scans, deploys and smoke-tests. Do not
> deploy by hand.
>
> `deploy/kubernetes/deploy.sh` rebuilds the ConfigMap and Secret from a local
> `.env`; if that file is partial it will **blank live secrets**. It is not part
> of the pipeline and should be run deliberately, if ever.

## CnA readiness

**CnA — Certification and Accreditation**: the formal security assurance process
a system passes before it may handle real data in production. *Certification* is
the technical assessment that the required controls exist and work;
*accreditation* is the accountable authority accepting the residual risk and
authorising the system to operate. In the NZ health context this is assessed
against the NZISM.

The five work items below map onto the control areas an assessor examines:
access control, data sovereignty, auditability and monitoring, vulnerability
management, and AI-specific safety controls.

Status of the five agreed work items, **verified against the running system on
30 July 2026** — not against the design intent. Where something is built but
unproven, it says so.

| # | Item | Status |
|---|---|---|
| 1 | RBAC for user activity management | ✅ **Live and verified** |
| 2 | Consume models hosted under client controls | ⚠️ **Partial** — one provider seam, two of four hosts |
| 3 | OTEL telemetry on documented key items | ⚠️ **Instrumented, not exporting** |
| 4 | Security scans | ✅ **Automated in CI — criticals blocked** |
| 5 | Guardrails around AI usage | ✅ **Live and verified** |

### 1. RBAC — live

Three roles (`admin`, `analyst`, `auditor`) with account states
`active` / `restricted` / `disabled`, enforced server-side on every request and
re-checked per call rather than only at login. Row-level scoping means an
analyst cannot reach another analyst's session even with a valid id. Every
allow and deny lands in the `AuditEvent` table with a PII-scrubbed payload.

Verified end to end: admin login issues a token; `/api/auth/me`,
`/api/sessions`, `/api/admin/users` and `/api/admin/audit` return 200 with it
and 401 without; a chat round-trip wrote `auth.login`, `session.create`,
`chat.message` and `session.delete` to the audit log.

Entra ID sign-in is implemented behind `AUTH_MODE=entra` but has **never been
run against a real tenant** — the live deployment is `AUTH_MODE=local`.

### 2. Client-hosted models — partial

There is a provider seam in `services/ai-service/llm.py`: switching hosts is an
environment change, not a code change. What exists today:

| Host | Status |
|---|---|
| OpenAI (direct) | ✅ In use live (`gpt-5.2-2025-12-11`) |
| Azure OpenAI / AI Foundry | ⚠️ Implemented, never exercised against a real tenant |
| AWS Bedrock | ❌ Not built |
| Google Vertex AI | ❌ Not built |
| Org model registry | ❌ Not built — model is a plain env string, not a registry lookup |

The Azure path installs an `AsyncAzureOpenAI` client and covers **OpenAI models
hosted in Foundry**. It does not cover Foundry's non-OpenAI catalogue, which
speaks a different API.

To close this properly the seam needs one adapter per host behind the existing
interface (Bedrock and Vertex both use their own SDKs and auth — IAM roles and
workload identity respectively, not API keys), plus a registry lookup so the
model is resolved by registered identifier and version rather than a free-text
env var. The seam is the right shape for that; the adapters simply do not exist
yet. **Treat multi-host support as unproven until it has been run against a real
subscription in each target.**

### 3. OTEL — instrumented but not exporting

Both services are instrumented: auto-instrumentation on HTTP/Express/Postgres
and FastAPI, plus custom spans carrying `gen_ai.*` semantic conventions
(`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens` /
`output_tokens`) and governance attributes (`circini.guardrail.decision`,
`circini.data_class`). Metrics: `gen_ai.client.token.usage` and
`circini.guardrail.decisions`. Audit events attach as span events.

**`OTEL_EXPORTER_OTLP_ENDPOINT` is unset in the live deployment**, so both pods
report `exporter=none`: spans are created in-process and dropped. Nothing is
observable outside the pod today. The remaining work is deploying a collector
and setting that variable — no application change.

### 4. Security scans — automated

Scanning runs on **every push and pull request**, not on request. Nothing
reaches production without passing.

| Layer | Tool | Gate |
|---|---|---|
| Application dependencies | `npm audit`, `pip-audit` | CRITICAL blocks; highs reported to the run summary |
| Container images | Trivy | CRITICAL blocks the deploy |
| Secrets in history | Gitleaks | any finding blocks |
| Kubernetes manifests | policy checks | hostPath, `:latest`, secret literals or `--reload` block |
| Application security controls | pytest suite | 44 tests; any failure blocks |

Image scanning immediately paid for itself, catching two criticals that
dependency auditing structurally cannot see because they live below the
application: **GnuTLS CVE-2026-42010** (authentication bypass via NUL
character) in the base OS layer, and a `tar` advisory inside the npm vendored
in the Node base image. Both are fixed — the images now apply OS security
updates at build time and upgrade npm.

Accepted, non-blocking findings:

- **`xlsx` (SheetJS) prototype pollution — no fix available.** A direct
  dependency that parses uploaded spreadsheets, so it sits in the
  untrusted-input path. Options are migrating to `exceljs` or sandboxing the
  parse. This is the main outstanding dependency risk.
- Six transitive backend highs (`brace-expansion`, `minimatch`, `glob`,
  `rimraf`, `gaxios`, `gcp-metadata`) pinned by `@opentelemetry` packages.
- The `vite` advisory affects the **dev server**. Production now serves a
  static build from nginx, so it no longer applies at runtime.

Not yet in place: SAST. Dependency, image, secret and manifest scanning are.

### 5. Guardrails — live

Enforced server-side in `services/ai-service/guardrails.py` on every chat call,
inbound and outbound. Detects NZ NHI, IRD, email, phone, DOB-in-context,
generic secrets (OpenAI/AWS keys, private keys), prompt-injection patterns and
denied-intent patterns. Outbound responses are redacted for PII and secrets.

Live config is `GUARDRAILS_ENABLED=true`, `PHI_MODE=false` — **Mode A**, meaning
health-identifiable data is blocked outright rather than redacted. Mode B
(`PHI_MODE=true`) redacts and proceeds instead.

Verified against the running app with synthetic data:

| Input | Decision |
|---|---|
| Fake NHI + date of birth | `blocked` — `health_pii_blocked_mode_a`, findings `nhi`, `dob` |
| "Ignore all previous instructions…" | `blocked` — `prompt_injection` |
| Benign migration question | `allow` |

Detection is regex-based. The interface is designed for Microsoft Presidio to
drop in behind it if richer NER is required for the production CnA build.

## CI/CD

Every push to `main` runs the same gated pipeline. There is no manual build or
deploy path.

```mermaid
flowchart LR
    P(["push to main"]) --> CI["CI<br/>typecheck · lint · 44 tests<br/>dep audit · secret scan<br/>manifest policy"]
    CI -- pass --> B["Build 3 images<br/>tag sha-&lt;commit&gt;<br/>push to GHCR"]
    CI -- fail --> X1["❌ stop"]
    B --> SC["Trivy scan<br/>CRITICAL blocks"]
    SC -- fail --> X2["❌ stop, nothing deployed"]
    SC -- pass --> D["Deploy<br/>self-hosted runner"]
    D --> SM["Smoke test<br/>19 assertions"]
    SM -- pass --> OK(["✅ live"])
    SM -- fail --> RB["↩️ automatic<br/>rollout undo"]

    classDef ok fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef bad fill:#fee2e2,stroke:#dc2626,stroke-width:2px,color:#0f172a
    classDef step fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    class OK ok
    class X1,X2,RB bad
    class CI,B,SC,D,SM step
```

**Why a self-hosted runner.** The k3s API server listens on `127.0.0.1` only,
so GitHub-hosted runners cannot reach the cluster. CD runs on a runner on the
node itself, authenticated as a ServiceAccount scoped to the `migration-agent`
namespace — it can manage this application and nothing else in the cluster.

**Credentials.** No long-lived registry credential is stored in the cluster.
The GHCR pull secret is minted from the deploy job's ephemeral token on every
run.

**Images.** Tagged `sha-<commit>` and never overwritten, so what is running is
always traceable to a commit and any previous build can be redeployed as-is.

| Concern | Before | Now |
|---|---|---|
| Build | manual `buildctl` from a working tree | CI from a commit |
| What's running | `:latest`, untraceable | `sha-<commit>` |
| Rollback | not possible — tag overwritten | redeploy an earlier tag |
| Source of truth | files on the host | the image |
| Checks | when someone remembered | every push, blocking |

## Project Structure

```
small_migration/
├── services/
│   ├── frontend/              # React + Vite + TypeScript
│   │   └── src/
│   │       ├── components/    # ChatArea, ChatInput, FileUpload, Brand, ThemeToggle, ui
│   │       ├── hooks/         # useRealtimeLogs (Socket.IO)
│   │       ├── pages/         # ChatPage, LoginPage, AdminPage
│   │       ├── services/      # API client, auth
│   │       └── types/         # TypeScript interfaces
│   ├── backend/               # Node.js + Express + Prisma
│   │   ├── prisma/            # Schema (User, Session, Message, AuditEvent, UsageRecord, ...)
│   │   └── src/
│   │       ├── middleware/    # auth (JWT / Entra ID), RBAC guards
│   │       ├── routes/        # auth, admin, sessions, chat, files, stt
│   │       ├── services/      # aiService proxy, audit, usage metering
│   │       └── otel.ts        # OpenTelemetry tracing
│   └── ai-service/            # Python FastAPI
│       ├── routes/
│       │   ├── migration.py   # Chat and migration endpoints
│       │   └── stt.py         # Speech-to-text (Whisper)
│       ├── utils/             # Realtime log broadcasting
│       ├── guardrails.py      # Input/output policy checks
│       ├── llm.py             # Centralised LLM client
│       ├── telemetry.py       # OpenTelemetry tracing
│       └── config.py          # Settings from environment
├── deploy/
│   └── kubernetes/            # K8s manifests, ingress and deploy script
├── docs/                      # ARCHITECTURE.md, CNA_IMPLEMENTATION.md
├── scripts/
│   ├── start-dev.sh           # Start all 3 services for local development
│   └── generate_*_doc.py      # Build .docx deliverables from docs/*.md
├── samples/                   # Sample template/mapping files for testing
└── output/                    # Generated files storage, local dev (gitignored)
```

## Setup

### Prerequisites

- Node.js 20+
- Python 3.12+
- PostgreSQL 15+

### 1. Environment Variables

**Backend** (`services/backend/.env`):

```
DATABASE_URL=postgresql://user:password@localhost:5432/migration_agent?schema=public
AI_SERVICE_URL=http://localhost:8084
PORT=3001
CORS_ORIGIN=http://localhost:5173
```

**AI Service** (`services/ai-service/.env`):

```
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.2
PORT=8084
OUTPUT_DIR=/path/to/output
BACKEND_URL=http://localhost:3001
```

### 2. Install Dependencies

```bash
# Backend
cd services/backend
npm install
npx prisma generate
npx prisma db push

# Frontend
cd ../frontend
npm install

# AI Service
cd ../ai-service
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 3. Run Locally

The quickest way to start all services:

```bash
./scripts/start-dev.sh
```

This launches:
- Frontend at http://localhost:5173
- Backend at http://localhost:3001
- AI Service at http://localhost:8084

Press Ctrl+C to stop all services.

To start services individually:

```bash
# AI Service
cd services/ai-service && source venv/bin/activate && uvicorn main:app --port 8084 --reload

# Backend
cd services/backend && npm run dev

# Frontend
cd services/frontend && npm run dev
```

## API Endpoints

### Backend (port 3001)

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | /api/health | public | Health check |
| POST | /api/auth/login | public | Exchange credentials for a JWT |
| GET | /api/auth/me | user | Current user and role |
| POST | /api/auth/change-password | user | Rotate own password |
| POST | /api/sessions | user (write) | Create session |
| GET | /api/sessions | user | List sessions visible to the caller |
| GET | /api/sessions/:id | user (owner/admin) | Get session with messages |
| DELETE | /api/sessions/:id | user (owner/admin) | Delete session |
| POST | /api/chat/:id/messages | user (write) | Send message (proxies to AI) |
| POST | /api/files/:id/upload | user (write) | Upload files to session |
| GET | /api/files/output/:id/download | user (owner/admin) | Download generated output |
| POST | /api/stt | user (write) | Transcribe recorded audio |
| GET | /api/admin/users | `admin` | List users |
| POST | /api/admin/users | `admin` | Create user |
| PATCH | /api/admin/users/:id | `admin` | Update role, status, token caps |
| GET | /api/admin/usage/summary | `admin` | Token usage per user |
| GET | /api/admin/audit | `admin`, `auditor` | Audit event log |
| GET | /api/admin/security/summary | `admin`, `auditor` | Guardrail and denial summary |
| POST | /api/logs/:sessionId | `x-internal-key` | Service-to-service log relay |

`user (write)` denies the read-only `auditor` role and any `restricted` account.
`owner/admin` means analysts reach only their own sessions.

### AI Service (port 8084)

Every `/ai` route except `/` and `/ai/health` requires the `x-internal-key`
shared secret. The middleware is fail-closed: an unset key returns `503`, a
wrong key `401`.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | /ai/health | public | Health check |
| POST | /ai/chat | `x-internal-key` | Process message with migration agent |
| GET | /ai/status/:id | `x-internal-key` | Get session file status |
| POST | /ai/reset/:id | `x-internal-key` | Reset session state and agent |
| POST | /ai/stt | `x-internal-key` | Transcribe audio to text (Whisper) |

## Agent Tools

The migration agent has access to these tools per session:

| Tool | Description |
|------|-------------|
| `read_file` | Store an uploaded file in session memory |
| `generate_output` | Write a generated SQL model to disk and return it |
| `list_files` | List all input and output files in the session |
| `get_file_content` | Retrieve content of a stored input or output file |

## Supported File Types

| Category | Description | Example |
|----------|-------------|---------|
| Template | Field requirements and nullability rules | `contractAdditionalInformation_template.csv` |
| Mapping | Source-to-target field mappings | `mapping_document.csv` |
| ADD_INFO | DBT transformation model | `AMS_AI_DBT_ADD_INFO.sql` |
| STG | DBT staging model | `AMS_AI_DBT_STG_ADD_INFO.sql` |

## Deployment

Deployment is automated. Pushing to `main` runs CI, builds the three images,
scans them, deploys, and smoke-tests — see [CI/CD](#cicd). There is no manual
build or `kubectl apply` step.

```bash
# Watch the current deploy
gh run watch

# What is running right now
kubectl get deploy -n migration-agent \
  -o custom-columns='NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image'

# Verify the deployment and its security controls at any time
./deploy/smoke-test.sh
```

### Rollback

Every commit's images stay in GHCR, so rolling back is redeploying an earlier
tag — no rebuild:

```bash
gh workflow run deploy.yml -f image_tag=sha-abc1234
```

The pipeline also rolls back on its own: if the rollout or the smoke test
fails, it runs `kubectl rollout undo` and re-verifies before reporting failure.

### One-time cluster bootstrap

```bash
deploy/kubernetes/bootstrap.sh            # namespace + scoped deploy ServiceAccount
deploy/kubernetes/runner-kubeconfig.sh    # kubeconfig for the CD runner
```

