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

```mermaid
flowchart TD
    R["Incoming request"] --> PUB{"Exact match in<br/>PUBLIC_PATHS?<br/><small>/api/health · /api/auth/login</small>"}
    PUB -- yes --> OK1["✅ Handler"]
    PUB -- no --> TOK{"Bearer token<br/>present?"}
    TOK -- no --> D1["❌ 401<br/>Authentication required"]
    TOK -- yes --> MODE{"AUTH_MODE"}

    MODE -- local --> JWT["Verify HS256 JWT<br/>issuer: circini-backend<br/>secret ≥ 32 chars, else startup fails"]
    MODE -- entra --> EJWT["Verify against tenant JWKS<br/>map app-roles / AD groups → role<br/>upsert local mirror, no password"]

    JWT --> USR{"User row found?"}
    EJWT --> USR
    USR -- no --> D2["❌ 401<br/>Invalid or expired token"]
    USR -- yes --> ST{"status"}
    ST -- disabled --> D3["❌ 403 + audit<br/>Account disabled"]
    ST -- "active / restricted" --> ROLE{"Route guard"}

    ROLE -- "requireRole(...)" --> RR{"role permitted?"}
    RR -- no --> D4["❌ 403 + audit<br/>Insufficient permissions"]
    RR -- yes --> OK2["✅ Handler"]

    ROLE -- requireWriteAccess --> WA{"auditor or<br/>restricted?"}
    WA -- yes --> D5["❌ 403 + audit<br/>Read-only"]
    WA -- no --> OK2

    classDef ok fill:#dcfce7,stroke:#16a34a,stroke-width:2px,color:#0f172a
    classDef deny fill:#fee2e2,stroke:#dc2626,stroke-width:2px,color:#0f172a
    classDef check fill:#dbeafe,stroke:#2563eb,stroke-width:2px,color:#0f172a
    class OK1,OK2 ok
    class D1,D2,D3,D4,D5 deny
    class JWT,EJWT check
```

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

> [!WARNING]
> **Current deployment posture.** Pods run in dev mode — they hostPath-mount
> source off the node and run `tsx watch` / `uvicorn --reload`. Source mounts are
> `readOnly`, so a file-write bug cannot reach the host tree, but building
> immutable images remains the durable fix. Update the hostPaths in
> `deploy/kubernetes/deployment.yaml` before moving or renaming any source
> directory, or the live site will break.

> [!NOTE]
> Use `kubectl apply -f deploy/kubernetes/deployment.yaml` to deploy.
> `deploy/kubernetes/deploy.sh` rebuilds the ConfigMap and Secret from a local
> `.env`; if that file is partial it will **blank live secrets**.

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

## Kubernetes Deployment

```bash
# Build images
docker build -t migration-agent-frontend:latest ./services/frontend
docker build -t migration-agent-backend:latest ./services/backend
docker build -t migration-agent-ai:latest ./services/ai-service

# Deploy
kubectl apply -f deploy/kubernetes/deployment.yaml

# Check status
kubectl get pods -n migration-agent
```

