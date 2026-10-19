# Circini Migration Agent

> Security status (8 September 2026): see [the implemented controls and outstanding evidence](docs/SECURITY_HARDENING.md). PHI and voice remain unavailable; Azure residency/retention and compliance approvals are not established. Older diagrams and verification dates below are historical design/deployment records, not current assurance evidence. The new controls require a validated pipeline release before they apply in production.

AI-powered DBT/SQL data migration assistant with a ChatGPT-like interface for analyzing mapping documents and generating Snowflake-compatible DBT models.

## Tech Stack

- **Frontend**: React 18, Vite, TypeScript, TailwindCSS, Socket.IO client, React Markdown, React Syntax Highlighter
- **Backend**: Node.js, Express, TypeScript, Prisma, PostgreSQL, Socket.IO, Multer (file uploads)
- **AI Service**: Python, FastAPI, LangGraph (10 agents in one turn graph; see `docs/LangGraph_Agent_Architecture.md`), LangSmith evals
- **Database**: PostgreSQL
- **Deployment**: AWS ECS Fargate, Docker, Application Load Balancer, ACM, CloudFormation

## Architecture

```mermaid
flowchart LR
    U["Browser"] -->|HTTPS| ALB["AWS ALB<br/>TLS termination"]
    ALB -->|"/"| FE["frontend<br/>React + Vite"]
    ALB -->|"/api · /socket.io"| BE["backend<br/>Express + Prisma"]
    BE -->|"POST /ai/chat<br/>x-internal-key"| AI["ai-service<br/>FastAPI + LangGraph"]
    AI -->|"/api/internal/*"| BE
    BE --> PG[("RDS PostgreSQL")]
    BE --> INT["GitHub · GitLab<br/>dbt Cloud · Snowflake"]
    AI --> DDB[("DynamoDB<br/>checkpoints + memory")]
    AI --> LLM["AWS Bedrock<br/>GPT-OSS 120B"]
```

| Piece | Role |
|---|---|
| ECS Fargate (`circini-demo`) | Runs the three services; they talk over Service Connect |
| RDS PostgreSQL 16 | Users, sessions, messages, files, audit, usage, AI activity logs |
| DynamoDB `circini-agent-checkpoints` | LangGraph thread state per chat (TTL 30 days); items over 350 KB offload to S3 |
| DynamoDB `circini-agent-memory` | LangGraph store: each user's standing instructions (no expiry) |
| AWS Bedrock (ap-southeast-2) | GPT-OSS 120B through the Converse API |
| OpenAI embeddings | Vectors for file and chat search |
| Secrets Manager `circini/*` | Injected into the tasks at start |
| ADOT sidecars · LangSmith (US) | Traces and metrics to X-Ray/CloudWatch · anonymised traces and eval runs |

Only `/api/*` and `/socket.io/*` are routed to the backend at the edge; everything
else is the frontend. The AI service has **no public route**: the backend reaches
it over ECS Service Connect, and every `/ai` call except `/ai/health` must carry
the shared `x-internal-key`. The middleware is **fail-closed** — an unset
`INTERNAL_API_KEY` returns `503`, a missing or wrong key `401`. The AI service in
turn reads GitHub, chat history and impact evidence only through the backend's
`/api/internal/*` gateway, under the authenticated user of the turn.

## Features

- **Chat Interface**: ChatGPT-style UI with persistent conversation history stored in PostgreSQL
- **Session Management**: Create, switch, search, rename, and delete chat sessions with a resizable sidebar
- **File Upload**: Attach up to 10 files per message (CSV, XLSX, SQL, JSON, YAML, TXT, XML, MD, PY, JS, TS, LOG)
- **Voice Input**: Disabled — `/ai/stt` refuses until an approved transcription boundary exists
- **AI Migration Agent**: Analyzes template and mapping documents, then generates Snowflake-compatible DBT SQL models through a LangGraph pipeline (analyst → author → validator → reviewer)
- **Realtime Logs**: Live status updates streamed from the AI service to the frontend via Socket.IO during processing
- **File Downloads**: Export generated SQL output files directly from chat messages
- **Workspace Integrations**: Connect GitHub/GitLab with OAuth, Snowflake with
  key-pair authentication, and dbt Cloud with a scoped service token; connection
  credentials are encrypted server-side and never returned to the browser
- **Resumable conversations**: Each chat is a LangGraph thread checkpointed in DynamoDB — a question the assistant asked (a missing base model, which evidence sources to use) pauses the thread and your reply resumes it; checkpoints expire after 30 days
- **Impact Analysis**: dbt lineage and change-risk answers from sources you confirm (uploads, saved chats, GitHub, GitLab, dbt Cloud, Snowflake metadata), cited as `file:line`
- **File Re-hydration**: Session files are automatically reloaded from the database when resuming a conversation
- **Access Control**: Email/password or Microsoft Entra ID sign-in, three roles, per-user token budgets
- **Response Feedback**: A thumbs up/down on every assistant response, with an optional note; admins read every user's ratings and notes in the portal
- **Audit Trail**: Every auth, authorisation, chat and file action recorded with a PII-scrubbed detail payload
- **Guardrails**: Health-PII and secret detection on the way in, redaction on the way out

## Security

### Authentication and authorisation

Every request passes four gates in order. A request that clears gate 1 skips
straight to the handler; any other failure is denied and audited.

| # | Gate | What it checks | On failure |
|---|---|---|---|
| 1 | **Public path** | Exact-match allowlist only — `/api/health`, `/api/auth/login`. No prefix matching, so nothing falls through by resembling a public route. | — (passes to handler) |
| 2 | **Valid token** | `local`: HS256 JWT, issuer `circini-backend` (startup fails if the secret is under 32 chars). `entra`: verified against the tenant JWKS, with app-roles / AD groups mapped to a role. An admin-issued [API key](#api-keys) (`cmk_…`) is accepted in every mode. | `401` |
| 3 | **Account enabled** | `disabled` is refused outright; `restricted` keeps read access but loses writes. | `403` + audit |
| 4 | **Role allows route** | `requireRole(...)` gates admin and auditor routes; `requireWriteAccess` blocks auditors and restricted accounts from any write. | `403` + audit |

Gates 2–4 are re-evaluated on **every** request, not just at login — revoking a
role or disabling an account takes effect on the user's next action rather than
when their token expires.

**Staying signed in.** Sign-in lasts one day by default. Tick **Keep me
signed in for 30 days** on the login page to stay signed in for 30 days on that
browser. The 5-minute Cognito ID token is renewed silently from the refresh
token, including after a page reload. Signing out revokes the refresh token in
Cognito, and a disabled or re-roled account is still refused on its next
request.

Service-to-service routes are **registered ahead of** the user-auth middleware
and carry their own fail-closed `requireInternalKey` guard. There is no path
prefix exemption inside `authenticate`, so a newly added route cannot silently
inherit an auth bypass.

### Roles

| Capability | `admin` | `analyst` | `auditor` |
|---|:--:|:--:|:--:|
| Own chat sessions, upload, generate | ✅ | ✅ | ❌ |
| See **all** sessions | ✅ | own only | ❌ |
| Rate a response, leave an optional note | ✅ | ✅ | ❌ |
| Read **all users'** feedback | ✅ | ❌ | ❌ |
| Manage users, set token budgets | ✅ | ❌ | ❌ |
| Create and revoke API keys | ✅ | ❌ | ❌ |
| Read audit log and security summary | ✅ | ❌ | ✅ |

A `restricted` status revokes write access without disabling the account;
`disabled` blocks sign-in outright. Sessions created before auth existed have no
owner and are admin-only.

### API keys

Admins create keys under **Settings → API keys** for scripts and other systems.
The key is shown once; afterwards only its SHA-256 digest and a short prefix are
kept. Send it as a bearer token:

```bash
curl -H "Authorization: Bearer $CIRCINI_API_KEY" https://migration-agent.uat.signify.net.nz/api/sessions
```

A key acts as the admin who created it on every REST and WebSocket route. It
expires after 30, 90, 180 or 365 days and stops working as soon as it is
revoked, or when its admin's role or status changes, their password is reset or
their access is revoked. Editing anything else, such as token limits, leaves it
working. A request made with a key cannot list, create or revoke keys, and every
mutation it makes is audited with `type: api_key`.

See [docs/API_KEYS.md](docs/API_KEYS.md) for the full scope and for examples on
Windows, macOS/Linux, Python, Node.js, Postman and CI.

### Chat request lifecycle

Every control below is enforced **server-side**. The browser is never trusted.

```mermaid
sequenceDiagram
    autonumber
    participant U as Browser
    participant B as backend
    participant A as ai-service
    U->>B: POST /api/chat/:id/messages (Bearer JWT)
    B->>B: auth · write access · session owner · token budget (429)
    B->>A: POST /ai/policy/check — screen before storing
    B->>B: save the screened message
    B->>A: POST /ai/chat + x-internal-key
    A->>A: run one LangGraph turn (see AI agents)
    A-->>B: reply · files · token usage
    B->>B: record usage · audit
    B-->>U: reply + generated files
```

While the turn runs, the AI service streams progress to the browser over
Socket.IO. The graph itself is shown step by step in
[AI agents (LangGraph)](#ai-agents-langgraph).

### Defence in depth

| # | Layer | Controls |
|---|---|---|
| 1 | Edge | ALB TLS 1.3 policy · HTTP→HTTPS · only `/api` and `/socket.io` reach the backend |
| 2 | Identity | Cognito OIDC JWT or admin API key · fail-closed `x-internal-key` between services |
| 3 | Authorisation | Role guards · write guard · per-session ownership |
| 4 | Quota | Per-user daily and monthly token caps → `429` |
| 5 | Input guardrails (`screen_input`) | Injection and deny patterns · encoded obfuscation · health PII blocked · PII and secrets redacted |
| 6 | Model guardrail (Injection Guard) | Paraphrased extraction, overrides, exfiltration, hidden instructions in files → `policy_gate`, fail-closed |
| 7 | Least-privilege agents | Per-agent tool allow-list · every tool read-only · identity from the turn, never the model · evidence sources only after the user confirms |
| 8 | Tool results | Backend payloads screened like uploads · `ToolNode` wrapper redacts and caps every result |
| 9 | Output (`screen_output`) | PII and secret redaction · images and HTML stripped · system-prompt canary · SQL static checks (one read-only `SELECT`, no DDL/DML) |
| 10 | Runtime and state | DynamoDB SSE + TTL · strict msgpack deserialisation · IAM role scoped to one table and bucket · non-root read-only containers |
| 11 | Audit and observability | Audit trail · per-call activity logs · OTEL · anonymised LangSmith traces |

### Secrets

`DATABASE_URL`, `JWT_SECRET`, `INTERNAL_API_KEY`, `INTEGRATION_ENCRYPTION_KEY`,
`AWS_BEARER_TOKEN_BEDROCK`, `OPENAI_API_KEY` (embeddings), `LANGSMITH_API_KEY`,
the GitHub App and GitLab OAuth credentials, `SEED_ADMIN_EMAIL` and
`SEED_ADMIN_PASSWORD` live in AWS Secrets Manager under `circini/*` and are
injected into the ECS task definitions — never baked into images. The AI
service reaches its DynamoDB checkpoints and S3 offload bucket through its IAM
task role, so it holds no database credential at all. `.env` is gitignored.

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
> Every secret lives in AWS Secrets Manager under `circini/*` and is injected
> into the task definition by CloudFormation. Nothing is read from a local
> `.env`, and no credential is stored on a developer machine.

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
| 4 | Security scans | ✅ **Automated in CI — all layers clean** |
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

Model access is a provider strategy in `services/ai-service/workflow/models.py`
behind `llm.configure_llm()`, which refuses to start unless the configured host,
region and model are the approved ones. Switching hosts is an environment change.

| Host | Status |
|---|---|
| AWS Bedrock (`ap-southeast-2`) | ✅ In use live — GPT-OSS 120B through the Converse API (`ChatBedrockConverse`) |
| OpenAI (direct) | ✅ Implemented, selectable with `LLM_PROVIDER=openai`; embeddings still use OpenAI |
| Azure OpenAI / AI Foundry | ⚠️ Implemented (`AzureChatOpenAI`), never exercised against a real tenant |
| Google Vertex AI | ❌ Not built |
| Org model registry | ❌ Not built — the model is an approved env value, not a registry lookup |

Search embeddings still go to OpenAI (`text-embedding-3-small`) to keep the
existing vector space, so the live deployment is not yet an all-Bedrock data
boundary.

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

### 4. Security scans — automated, clean

Scanning runs on **every push and pull request**. Nothing reaches production
without passing, and every layer is currently clean.

| Layer | Tool | Gate | Status |
|---|---|---|---|
| Application dependencies | `npm audit`, `pip-audit` | HIGH blocks | ✅ 0 findings |
| Container images | Trivy | CRITICAL blocks | ✅ 0 findings |
| Static analysis (SAST) | Semgrep, 569 rules | any finding blocks | ✅ 0 findings |
| Secrets in history | Gitleaks | any finding blocks | ✅ clean |
| Kubernetes manifests | policy checks | hostPath, `:latest`, secret literals or `--reload` block | ✅ pass |
| Security, guardrail and agent-graph tests | pytest | any failure blocks | ✅ 184 tests |
| Agent quality | LangSmith evals (live model) | below threshold blocks the deploy | ✅ gate passing |

Reaching clean required fixing rather than suppressing:

- **`xlsx`** — the npm copy is abandoned at 0.18.5 with an unfixable
  prototype-pollution advisory. Now sourced from SheetJS's official
  distribution (0.20.3), which fixes it with an identical API. `exceljs` was
  evaluated and rejected: it brings nine highs of its own.
- **OpenTelemetry** — every remaining backend high descended from
  `auto-instrumentations-node` via its GCP resource detector. Replaced with
  explicit HTTP and Express instrumentations, which also stops the process
  loading adapters for a dozen services this app never calls.
- **Image CVEs** — Trivy caught two criticals below the application layer that
  dependency auditing structurally cannot see, including GnuTLS
  **CVE-2026-42010** (authentication bypass via NUL character). Images now
  apply OS security updates at build time.
- **Containers** — all three now run unprivileged with a read-only root
  filesystem, all capabilities dropped and privilege escalation disabled.
- **Fonts** — self-hosted rather than loaded from Google. Subresource
  integrity cannot be applied to Google Fonts (the CSS varies by user agent),
  and self-hosting also stops user IPs and referrers reaching a third party on
  every page load.
- **Supply chain** — all GitHub Actions pinned to commit SHAs, not mutable
  tags.

One suppression exists: the favicon is an inline `data:` URI, so the
missing-integrity rule is a verified false positive. It is suppressed on that
single line with the reasoning recorded, not by relaxing the ruleset.

### 5. Guardrails — live

Layered around the LangGraph agents (`services/ai-service/workflow/security.py`),
following LangChain's guardrail guidance — before the agent, around tools, human
in the loop, and after the agent:

| Layer | Where | What it does |
|---|---|---|
| Deterministic input | `screen_input` node · `guardrails.py` | NZ NHI, IRD, email, phone, DOB-in-context, secrets, prompt-injection and denied-intent patterns, encoded obfuscation; health PII blocked (Mode A) |
| Model-based input | Injection Guard (parallel with the router) → `policy_gate` | Catches paraphrased extraction, overrides, exfiltration requests and instructions hidden in uploads; fails closed |
| Around tools | gateway screening + `ToolNode(awrap_tool_call=…)` | Backend payloads screened like uploads; every result redacted and capped; read-only tools only |
| Human in the loop | `ask_sources` / `clarify` / `ask_user` (`interrupt()`) | Evidence is read only from sources the user confirmed; the backend re-checks the grant |
| Output | `screen_output` node | PII and secret redaction, images/HTML stripped, system-prompt canary |

Live config is `GUARDRAILS_ENABLED=true`, `PHI_MODE=false` — **Mode A**, meaning
health-identifiable data is blocked outright rather than redacted.

The model-based guard is measured by the LangSmith eval suite: 28/28 attacks
caught and 0/40 false positives on the last calibration run (see
[docs/Agent_Evals.md](docs/Agent_Evals.md)).

## CI/CD

Every push to `main` runs the same gated pipeline. There is no manual build or
deploy path. The agent evals also run nightly against the live model.

```mermaid
flowchart LR
    P(["push to main"]) --> CI["CI<br/>tests · lint · security scans"]
    CI --> EV["Agent evals<br/>LangSmith · live Bedrock"]
    CI --> IMG["Build + scan images<br/>tag sha-commit"]
    EV --> D["Deploy<br/>CloudFormation · ECS"]
    IMG --> D
    D --> V["Production checks"]
    V --> OK(["live"])
```

Any failing stage stops the pipeline and nothing is deployed. If the production
checks fail after a deploy, redeploy the last good `sha-<commit>` tag.

| Stage | What runs |
|---|---|
| CI | Typecheck, lint, build · AI tests incl. DynamoDB checkpoints · backend security integration tests · pip-audit, Trivy fs, Semgrep, Gitleaks |
| Agent evals | Router, guard, grant judge, generation, impact, history, repository and consult suites; below threshold blocks the deploy |
| Build + scan | Three images pushed to ECR · Trivy image scan, `CRITICAL` blocks |
| Deploy | OIDC role · business-hours hold · network, data and Cognito stacks · Bedrock preflight · app stack · schema sync · roll services |
| Production checks | Smoke · GitHub · chat search · impact agent · agent graph |

**Why GitHub-hosted runners.** CD runs on standard GitHub-hosted runners and
reaches AWS over the public API, so there is no self-hosted runner and no
machine to patch. The job assumes `circini-github-deploy` via GitHub OIDC,
scoped to this account's `circini-*` resources and nothing else.

**Credentials.** No long-lived AWS key exists anywhere. The deploy job mints a
short-lived OIDC token per run, and ECR login is derived from that same
assumed role.

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
│   └── ai-service/            # Python FastAPI + LangGraph
│       ├── routes/
│       │   ├── migration.py   # /ai/chat and the other /ai endpoints
│       │   └── stt.py         # Voice input — refuses until an approved boundary exists
│       ├── workflow/          # The agent runtime
│       │   ├── orchestrator.py    # Turn graph + specialist registry
│       │   ├── nodes.py           # screen_input · policy_gate · dispatch · screen_output
│       │   ├── agents/            # Router, Injection Guard, Grant Judge, History, Repository,
│       │   │                      # Consultant, migration/ and impact/ subgraphs, tool-loop base
│       │   ├── tools/             # Read-only tools (files, GitHub, chat search, evidence)
│       │   ├── gateway.py         # Backend gateway — identity from the turn, payloads screened
│       │   ├── models.py          # Provider strategy + per-agent model profiles
│       │   ├── security.py        # Guardrail layers around the agents
│       │   ├── checkpointing.py   # DynamoDB checkpointer (memory for local runs)
│       │   ├── tracing.py         # Anonymised LangSmith tracing
│       │   └── runner.py          # TurnRunner: resume or start a thread, map the result
│       ├── prompts/           # System prompts per agent + shared security rules
│       ├── evals/             # LangSmith datasets, evaluators, thresholds, runner
│       ├── tests/             # pytest: graph, pipelines, guardrails, DynamoDB (moto)
│       ├── guardrails.py      # Pattern-based input/output policy checks
│       ├── validation.py      # Static SQL/dbt checks (sqlglot)
│       ├── llm.py             # Approved-provider validation, security status
│       ├── telemetry.py       # OpenTelemetry tracing
│       └── config.py          # Settings from environment
├── deploy/
│   └── aws/                   # CloudFormation stacks: network, data, cognito, app
├── docs/                      # ARCHITECTURE.md, LangGraph_Agent_Architecture.md, Agent_Evals.md, …
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
PUBLIC_APP_URL=http://localhost:5173
INTEGRATION_ENCRYPTION_KEY=<random value of at least 32 characters>
# Optional OAuth connections
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITLAB_CLIENT_ID=
GITLAB_CLIENT_SECRET=
```

**AI Service** (`services/ai-service/.env`):

```
LLM_PROVIDER=bedrock
BEDROCK_REGION=ap-southeast-2
BEDROCK_MODEL=openai.gpt-oss-120b-1:0
APPROVED_LLM_HOST=bedrock-runtime.ap-southeast-2.amazonaws.com
PROCESSING_REGION=ap-southeast-2
AWS_BEARER_TOKEN_BEDROCK=
OPENAI_API_KEY=                 # search and long-term memory embeddings
INTERNAL_API_KEY=               # shared with the backend
CHECKPOINT_BACKEND=memory       # dynamodb in AWS — this chat, 30-day TTL
MEMORY_BACKEND=memory           # dynamodb in AWS — this user, no expiry
MEMORY_RECALL_LIMIT=5           # standing instructions injected per turn
SUMMARY_TRIGGER_CHARS=60000     # older turns are condensed past this
LANGGRAPH_STRICT_MSGPACK=true
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
pip install -r requirements-dev.txt   # runtime + tests + evals
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

See the [Swagger / OpenAPI guide](docs/api/README.md) for API-key authentication,
key management, chat/file request schemas, and an interactive local viewer.
The [OpenAPI YAML](docs/api/openapi.yaml) can be imported into Swagger UI or Postman.

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
| PUT | /api/feedback/messages/:id | user (write, owner/admin) | Rate an assistant response, optionally with a note |
| DELETE | /api/feedback/messages/:id | user (write, owner/admin) | Withdraw a rating and its note |
| POST | /api/files/:id/upload | user (write) | Upload files to session |
| GET | /api/integrations | user | List the current user's connection states |
| POST | /api/integrations/:provider/connect | user (write) | Start or validate a connection |
| DELETE | /api/integrations/:provider | user (write) | Disconnect a provider |
| GET | /api/files/output/:id/download | user (owner/admin) | Download generated output |
| POST | /api/stt | user (write) | Transcribe recorded audio |
| GET | /api/admin/users | `admin` | List users |
| POST | /api/admin/users | `admin` | Create user |
| PATCH | /api/admin/users/:id | `admin` | Update role, status, token caps |
| GET | /api/admin/usage/summary | `admin` | Token usage per user |
| GET | /api/admin/feedback | `admin` | Every user's response ratings and notes |
| GET | /api/admin/audit | `admin`, `auditor` | Audit event log |
| GET | /api/admin/security/summary | `admin`, `auditor` | Guardrail and denial summary |
| GET | /api/api-keys | `admin` (session) | List every API key and its status |
| POST | /api/api-keys | `admin` (session) | Create a key — the response is the only time it is shown |
| DELETE | /api/api-keys/:id | `admin` (session) | Revoke a key |
| POST | /api/logs/:sessionId | `x-internal-key` | Service-to-service log relay |

`user (write)` denies the read-only `auditor` role and any `restricted` account.
`owner/admin` means analysts reach only their own sessions.
`(session)` means the route refuses a request authenticated with an API key.

### AI Service (port 8084)

Every `/ai` route except `/` and `/ai/health` requires the `x-internal-key`
shared secret. The middleware is fail-closed: an unset key returns `503`, a
wrong key `401`.

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | /ai/health | public | Health check |
| POST | /ai/chat | `x-internal-key` | Run one chat turn through the LangGraph turn graph |
| POST | /ai/policy/check | `x-internal-key` | Screen a message, files and history before the backend stores them |
| GET | /ai/status/:id | `x-internal-key` | Model files generated in the chat's thread |
| POST | /ai/reset/:id | `x-internal-key` | Delete the chat's checkpoints and legacy output folder |
| GET | /ai/memory/:user | `x-internal-key` | Standing instructions remembered for that user |
| DELETE | /ai/memory/:user | `x-internal-key` | Erase everything remembered for that user |
| POST | /ai/cancel/user/:id | `x-internal-key` | Cancel a user's running turns (access revoked) |
| POST | /ai/files/embed | `x-internal-key` | Screened search embeddings |
| POST | /ai/validation/test | `x-internal-key` | Static checks + sandboxed synthetic fixture test for SQL |
| GET | /ai/security/status | `x-internal-key` | Provider boundary, guardrail and tracing configuration |
| POST | /ai/stt | `x-internal-key` | Refuses — voice input is unavailable |

## AI agents (LangGraph)

Each chat turn is one run of a LangGraph `StateGraph`, and each chat is one
thread (`thread_id` = chat session id). Code: `services/ai-service/workflow/`
(`orchestrator.py` builds the graph, `runner.py` runs it). Design notes:
[docs/LangGraph_Agent_Architecture.md](docs/LangGraph_Agent_Architecture.md).

### At a glance

A simplified view of the whole graph. Every box is a real node name from
`services/ai-service/workflow/`; the detailed diagrams further down show every
edge, State key and subgraph. Read top to bottom: guard the input, decide what
the user wants, run one specialist, remember, guard the output.

```mermaid
flowchart TD
    subgraph GUARD["1 · Guard and understand"]
        screen_input["screen_input<br/>input guardrails"]
        screen_input --> route_intent["route_intent<br/>Router Agent"]
        screen_input --> injection_guard["injection_guard<br/>Injection Guard Agent"]
        screen_input --> recall_memories["recall_memories<br/>user memory from Store"]
        screen_input --> summarize_history["summarize_history<br/>Summarizer Agent"]
        route_intent --> policy_gate
        injection_guard --> policy_gate
        recall_memories --> policy_gate
        summarize_history --> policy_gate
        policy_gate{"policy_gate<br/>apply the rules"}
    end

    IN(["User message<br/>POST /ai/chat"]) --> screen_input

    screen_input -. "blocked" .-> E([END])
    policy_gate -. "injection found" .-> E
    policy_gate --> dispatch{"dispatch<br/>pick one specialist by route"}

    subgraph SPEC["2 · One specialist runs"]
        GEN["generate subgraph<br/>analyze → plan_builds → build_model → publish<br/>build_model = author → validate → review"]
        IMP["impact subgraph<br/>plan_sources → investigate → evidence_gate → report"]
        HIS["history subgraph<br/>search → delivery_gate → deliver_files"]
        consult["consult<br/>Migration Consultant Agent"]
        repository["repository<br/>Repository Agent"]
        scope_guard["scope_guard<br/>decline off-topic"]
    end

    dispatch -- "generate" --> GEN
    dispatch -- "impact" --> IMP
    dispatch -- "history" --> HIS
    dispatch -- "consult" --> consult
    dispatch -- "repository" --> repository
    dispatch -- "out_of_scope" --> scope_guard

    GEN -. "interrupt(): ask the user,<br/>resume next message" .-> PAUSE[("checkpoint saved<br/>turn paused")]
    IMP -. "interrupt(): ask the user,<br/>resume next message" .-> PAUSE
    PAUSE -. "user answers · rerun" .-> screen_input

    GEN --> AS{"after_specialist"}
    IMP --> AS
    HIS --> AS
    consult --> AS
    repository --> AS
    scope_guard --> AS

    subgraph FIN["3 · Remember and guard the output"]
        capture_memory["capture_memory<br/>write to Store"]
        capture_memory --> screen_output["screen_output<br/>output guardrails, PII and secrets"]
    end

    AS --> capture_memory
    screen_output --> E
    E --> OUT(["Reply, files, usage"])

    classDef llm fill:#E5F4FF,stroke:#006DDD,stroke-width:2px,color:#030710
    classDef code fill:#E6F7EC,stroke:#16A34A,stroke-width:2px,color:#030710
    classDef sub fill:#FFF4E5,stroke:#D97706,stroke-width:2px,color:#030710
    classDef routing fill:#F1F5F9,stroke:#64748B,stroke-width:2px,color:#030710
    class route_intent,injection_guard,summarize_history,consult,repository llm
    class screen_input,recall_memories,scope_guard,capture_memory,screen_output code
    class GEN,IMP,HIS sub
    class policy_gate,dispatch,AS routing
```

| Colour | Meaning |
|---|---|
| Blue | Calls the LLM |
| Green | Plain code, no LLM |
| Amber | A subgraph: its own small graph, used as one node |
| Grey | Routing only: chooses the next node from State |

### Complete flow: input to output

One chat message is one run of the turn graph. Each box names what it is
(**Agent**, **Node** or **Subgraph**, see the key below), what it does, and its
node name in the code. Arrows are edges, and each label says why the turn goes
that way.

```mermaid
%%{init: {"flowchart": {"padding": 16, "wrappingWidth": 260}}}%%
flowchart TD
    IN(["INPUT · POST /ai/chat<br/>message, files, history, user"])
    IN --> RUN["TurnRunner<br/>starts the turn<br/>request data goes in Runtime<br/>context, never in State"]
    RUN --> LOAD[("Load checkpoint<br/>this chat's saved State<br/>DynamoDBSaver · thread = chat id")]
    LOAD --> Q{"Is the thread paused,<br/>waiting for the user?"}
    Q -- "no · new run with TurnInput" --> S0
    Q -- "yes · Command(resume)" --> PAUSED["Paused node runs again<br/>with the user's answer<br/>sets State.rerun = true"]

    subgraph TURN["Turn graph · StateGraph migration_assistant · State = TurnState"]
        S0(["START"]) --> SI["Node: screen_input<br/>checks the incoming message<br/>guardrails, no LLM"]
        SI -- "blocked · go to END" --> E0(["END"])
        SI -- "safe · fan out: 4 nodes in parallel" --> RT["Router Agent<br/>works out what the user wants<br/>node: route_intent"]
        SI --> IG["Injection Guard Agent<br/>looks for prompt injection<br/>node: injection_guard"]
        SI --> RM["Node: recall_memories<br/>loads what we know about the user<br/>from the Store, no LLM"]
        SI --> SUM["Summarizer Agent<br/>shortens a long chat history<br/>node: summarize_history"]
        RT --> PG{"Node: policy_gate<br/>waits for all 4,<br/>then applies the rules"}
        IG --> PG
        RM --> PG
        SUM --> PG
        PG -- "injection found · go to END" --> E0
        PG -- "impact follow-up on sources<br/>the user already approved" --> GJ["Grant Judge Agent<br/>is this still the approved analysis?<br/>node: grant_judge"]
        PG --> DI{"Node: dispatch<br/>picks the specialist<br/>from State.route"}
        GJ --> DI
        DI -- "route = generate" --> GEN["Subgraph: generate<br/>writes dbt / SQL models<br/>Requirements Analyst, Model Author,<br/>Model Reviewer agents"]
        DI -- "route = impact" --> IMP["Subgraph: impact<br/>what breaks if this changes?<br/>Evidence Investigator,<br/>Impact Reporter agents"]
        DI -- "route = history" --> HIS["Subgraph: history<br/>finds an earlier chat or file<br/>History Agent"]
        DI -- "route = consult" --> CON["Migration Consultant Agent<br/>answers migration questions<br/>node: consult, tool loop"]
        DI -- "route = repository" --> REP["Repository Agent<br/>reads the GitHub repo<br/>node: repository, tool loop"]
        DI -- "route = out_of_scope" --> SG["Node: scope_guard<br/>politely declines off-topic<br/>no LLM"]
        GEN --> AS{"Conditional edge<br/>after_specialist<br/>checks State.rerun"}
        IMP --> AS
        HIS --> AS
        CON --> AS
        REP --> AS
        SG --> AS
        AS -- "rerun · the user just answered,<br/>check and route it again" --> SI
        AS -- "done" --> CM["Node: capture_memory<br/>saves anything worth remembering<br/>to the Store, no LLM"]
        CM --> SO["Node: screen_output<br/>checks the reply before sending<br/>removes secrets and PII"]
        SO --> E0
    end

    PAUSED --> AS
    GEN -. "interrupt() · pause and ask the user" .-> SAVE
    IMP -. "interrupt() · pause and ask the user" .-> SAVE
    E0 --> SAVE[("Save checkpoint<br/>State written once per turn<br/>durability = exit")]
    SAVE --> OUT(["OUTPUT · TurnResult<br/>reply, files, token usage, paused?"])

    classDef agent fill:#dbeafe,stroke:#2563eb,color:#0f172a
    classDef step fill:#dcfce7,stroke:#16a34a,color:#0f172a
    classDef sub fill:#fef3c7,stroke:#d97706,stroke-width:3px,color:#0f172a
    class RT,IG,SUM,GJ,CON,REP agent
    class SI,RM,PG,DI,SG,AS,CM,SO step
    class GEN,IMP,HIS sub
```

| Term | What it means here |
|---|---|
| **Agent** (blue) | A node that calls the LLM. Some agents also use read-only tools in a tool loop. |
| **Node** (green) | One step in the graph. Plain Python code, no LLM. |
| **Subgraph** (amber) | A small graph of its own, used as one node. Its agents are listed in the box and drawn below. |
| **State** | `TurnState`, the shared data every node reads and writes during the turn (route, reply, files, `rerun`). |
| **Edge** | The next step. A **conditional edge** picks the next step from State. |
| **Checkpoint** | This chat's State, saved in DynamoDB so a paused turn can resume. |
| **Store** | Long-term memory for each user, kept across chats. |

The LLM never decides whether a guardrail applies, whose files get read, or what
reaches the user. Nodes (plain code) do.

When a subgraph needs something from the user, such as a missing base model or
which evidence sources to use, it calls `interrupt()`. The run stops, the
checkpoint is saved, and the question becomes the reply. The user's next message
resumes the thread with `Command(resume=...)` and is then screened and routed
like any other message.

### The graph in "Thinking in LangGraph" terms

This section follows the five steps in LangChain's
[Thinking in LangGraph](https://docs.langchain.com/oss/python/langgraph/thinking-in-langgraph)
guide. Every name below is the exact node, State key or tool name in
`services/ai-service/workflow/`.

#### 1. Map out the workflow as discrete steps

Each box is a LangGraph node, named as in `add_node`. Solid arrows are fixed
edges (`add_edge`). Dotted arrows are dynamic routing: a node returning
`Command(goto=...)`, a conditional edge (`add_conditional_edges`), or `Send`. The
two diamonds are conditional-edge functions, not nodes. Each grey cluster is a
compiled subgraph used as one node of the turn graph.

```mermaid
flowchart TD
    tS([START]) --> screen_input
    screen_input -. "Command: blocked" .-> tE([END])
    screen_input -. "Command: goto 4 nodes in parallel" .-> route_intent
    screen_input -.-> injection_guard
    screen_input -.-> recall_memories
    screen_input -.-> summarize_history
    route_intent --> policy_gate
    injection_guard --> policy_gate
    recall_memories --> policy_gate
    summarize_history --> policy_gate
    policy_gate -. "Command: injection flagged" .-> tE
    policy_gate -. "Command: impact turn on a confirmed grant" .-> grant_judge
    policy_gate -. "Command" .-> dispatch
    grant_judge -. "Command" .-> dispatch

    dispatch -. "route = generate" .-> gS
    dispatch -. "route = impact" .-> iS
    dispatch -. "route = history" .-> hS
    dispatch -. "route = consult" .-> consult
    dispatch -. "route = repository" .-> repository
    dispatch -. "route = out_of_scope" .-> scope_guard

    subgraph GEN["generate · subgraph · MigrationState"]
        gS([START]) --> analyze
        analyze -. "Command: not ready or has questions" .-> clarify
        analyze -. "Command: targets" .-> plan_builds
        analyze -. "Command: no targets" .-> publish
        plan_builds -. "Send × each target, max 6" .-> bS
        subgraph BUILD["build_model · subgraph per target · BuildState"]
            bS([START]) --> author
            author -. "Command" .-> validate
            validate -. "Command: passed" .-> review
            validate -. "Command: rejected, attempts left" .-> author
            validate -. "Command: rejected, 3 attempts used" .-> bfinish["finish"]
            review -. "Command: defects, attempts left" .-> author
            review -. "Command: approved, no issues, or no attempts left" .-> bfinish
            bfinish --> bE([END])
        end
        bE --> publish
        clarify --> gE([END])
        publish --> gE
    end

    subgraph IMP["impact · subgraph · ImpactState"]
        iS([START]) --> plan_sources
        plan_sources -. "Command: sources not confirmed" .-> ask_sources
        plan_sources -. "Command: grant confirmed" .-> investigate
        investigate -. "Command" .-> evidence_gate
        evidence_gate -. "Command: nothing read, or open questions (once each)" .-> investigate
        evidence_gate -. "Command: ready and grounded" .-> report
        evidence_gate -. "Command: otherwise" .-> ask_user
        report -. "Command" .-> ifinish["finish"]
        ask_sources --> iE([END])
        ask_user --> iE
        ifinish --> iE
    end

    subgraph HIS["history · subgraph · HistoryState"]
        hS([START]) --> search
        search --> delivery_gate
        delivery_gate -. "Command: requested_files set" .-> deliver_files
        delivery_gate -. "Command: user asked for the file" .-> locate_file
        delivery_gate -. "Command: otherwise" .-> hE([END])
        locate_file -. "Command: filename matched" .-> deliver_files
        locate_file -. "Command: no filename or no match" .-> hE
        deliver_files --> hE
    end

    gE --> AS{"after_specialist<br/>conditional edge"}
    iE --> AS
    hE --> AS
    consult --> AS
    repository --> AS
    scope_guard --> AS
    AS -. "rerun: a paused question was answered" .-> screen_input
    AS -. "otherwise" .-> capture_memory
    capture_memory --> screen_output
    screen_output --> tE

    classDef llm fill:#E5F4FF,stroke:#006DDD,stroke-width:2px,color:#030710
    classDef data fill:#E6F7EC,stroke:#16A34A,stroke-width:2px,color:#030710
    classDef action fill:#FFF4E5,stroke:#D97706,stroke-width:2px,color:#030710
    classDef user fill:#F3E8FF,stroke:#9333EA,stroke-width:2px,color:#030710
    classDef routing fill:#F1F5F9,stroke:#64748B,stroke-width:2px,color:#030710
    class route_intent,injection_guard,summarize_history,grant_judge,analyze,author,review,investigate,report,search,consult,repository llm
    class recall_memories,plan_sources,validate,evidence_gate,locate_file data
    class screen_input,scope_guard,publish,bfinish,ifinish,deliver_files,capture_memory,screen_output action
    class clarify,ask_sources,ask_user user
    class policy_gate,dispatch,plan_builds,delivery_gate routing
```

`consult`, `repository`, `analyze`, `investigate` and `search` each run a
**tool loop** inside the node. The tool loop is a small compiled graph with
`checkpointer=False`:

```mermaid
flowchart LR
    S([START]) --> model
    model -. "tool calls" .-> tools["tools<br/>ToolNode + guard_tool_call"]
    model -. "no answer yet, max 2 nudges" .-> nudge
    model -. "answered" .-> E([END])
    tools -. "no result submitted" .-> model
    tools -. "submit_* result recorded" .-> E
    nudge --> model

    classDef llm fill:#E5F4FF,stroke:#006DDD,stroke-width:2px,color:#030710
    classDef data fill:#E6F7EC,stroke:#16A34A,stroke-width:2px,color:#030710
    classDef action fill:#FFF4E5,stroke:#D97706,stroke-width:2px,color:#030710
    class model llm
    class tools data
    class nudge action
```

#### 2. Identify what each step needs to do

The guide sorts steps into four kinds. Colours match the diagram above.

| Kind | Nodes |
|---|---|
| **LLM step** (blue): understand, analyse, generate or decide | `route_intent`, `injection_guard`, `summarize_history` (only once the chat outgrows the window), `grant_judge`, `analyze`, `author`, `review`, `investigate`, `report`, `search`, `consult`, `repository` |
| **Data step** (green): read information | `recall_memories` (Store search), `plan_sources` (backend grant), `validate` (sqlglot static checks, never a warehouse run), `evidence_gate` (were the reads real?), `locate_file` (user's own files) |
| **Action step** (amber): do something with an effect | `screen_input` and `screen_output` (guardrails), `scope_guard`, `publish` (save files), `deliver_files`, `capture_memory` (Store write; calls the LLM only when the user asked to remember something and the turn saved nothing), both `finish` nodes |
| **User input step** (purple): pause for the user | `clarify`, `ask_sources`, `ask_user`. Each calls `interrupt()` first, then re-runs on resume and sets `rerun = true` |
| **Routing** (grey): only choose the next node | `policy_gate`, `dispatch`, `plan_builds`, `delivery_gate`. This fifth kind is ours, not the guide's |

#### 3. Design your state

As the guide says, State holds raw data, not formatted text; each node builds its
own prompt. Bulky per-turn inputs (message, files, history, user, backend
gateway, logger) travel in the **Runtime context** (`TurnContext`) and are never
checkpointed.

```python
class TurnState(TypedDict, total=False):
    # Reset at the start of every turn by screen_input.
    turn_id: str
    message: str
    guardrail: GuardrailVerdict
    route: RouteDecision | None                  # {route, new_analysis}
    safety: dict[str, Any] | None                # Injection Guard verdict
    response: Annotated[str, latest]
    outputs: Annotated[dict[str, str], latest]   # file name -> content
    impact_action: Annotated[str | None, latest]
    rerun: Annotated[bool, latest]               # a paused step was answered
    # Carried across turns in the thread's checkpoint.
    last_route: Annotated[str | None, latest]
    summary: Annotated[str, latest]
    summarized_upto: Annotated[int, latest]
    pending: Annotated[PendingInput | None, latest]   # the question we are waiting on
    migration: Annotated[MigrationWork, latest]       # {spec, drafts}
    impact: Annotated[ImpactWork, latest]             # {analysis_id, evidence_reads}
```

`latest` is a last-write-wins reducer for keys that subgraphs write back.
`input_schema=TurnInput` (`turn_id`) and `output_schema=TurnOutput` (`response`,
`outputs`, `impact_action`, `guardrail`, `route`) keep everything else internal.

Each subgraph shares some keys with `TurnState` and keeps some of its own:

| State | Keys private to the subgraph |
|---|---|
| `MigrationState` (generate) | `built` (reducer `operator.add`, collects every `Send` branch) |
| `BuildState` (build_model) | `target`, `spec`, `previous`, `attempt`, `sql`, `notes`, `generation_error`, `capture_mode`, `truncated`, `recovering`, `feedback`, `validation`, `review`, `built` |
| `ImpactState` (impact) | `dossier`, `evidence_reads`, `started`, `reread`, `deepened` |
| `HistoryState` (history) | `requested_files` |
| `LoopState` (tool loop) | `messages` (reducer `add_messages`), `rounds`, `nudges`, `result` |

Memory has two halves. The **checkpointer** (`DynamoDBSaver`) keeps one chat's
State: one thread per chat, written once per turn (`durability="exit"`), expired
after 30 days (`CHECKPOINT_TTL_DAYS`). The **Store** (`DynamoDBStore`) keeps each
user's long-term memories, with no TTL.

#### 4. Build your nodes

Each specialist is registered against a route, so `dispatch` never needs
changing when one is added:

| Route | Node | Built from |
|---|---|---|
| `generate` | `generate` | `build_migration_graph()` subgraph |
| `impact` | `impact` | `build_impact_graph()` subgraph |
| `history` | `history` | `build_history_graph()` subgraph |
| `consult` | `consult` | `ConsultantAgent()` (tool loop) |
| `repository` | `repository` | `RepositoryAgent()` (tool loop) |
| `out_of_scope` | `scope_guard` | `scope_guard` function |

**All tools.** The tools run in `ToolNode`, and `guard_tool_call` screens and
size-caps every result. Every tool is read-only except `remember` and `forget`
(which write the user's Store) and `request_file_delivery` (which queues a file
for this reply).

| Tool | Used by (node) | What it does |
|---|---|---|
| `list_files` | `consult` | List the files attached to this turn |
| `get_file_content` | `consult` | Read one attached file by its exact label |
| `remember` | `consult` | Save a standing instruction to the user's Store |
| `forget` | `consult` | Delete a standing instruction from the Store |
| `github_connection_status` | `repository`, `analyze` | Check the user's GitHub authorisation and saved repo/branch |
| `list_github_repositories` | `repository`, `analyze` | List repos the GitHub App can reach |
| `list_github_files` | `repository`, `analyze` | List file paths at a branch or commit |
| `read_github_file` | `repository`, `analyze` | Read one repo file (max 200 KB) |
| `search_chat_history` | `search` | Search saved chat messages; the loop nudges the agent to call it first |
| `search_chat_files` | `search` | Find uploaded or generated files across the user's chats |
| `request_file_delivery` | `search` | Queue a found file to attach to this reply (max 3) |
| `read_impact_evidence` | `investigate` | Read confirmed evidence only: `uploads`, `history`, `github`, `gitlab`, `dbt`, `snowflake` |
| `submit_migration_spec` | `analyze` | Return the final `MigrationSpec` (generated from `output_schema`) |
| `submit_evidence_dossier` | `investigate` | Return the final `EvidenceDossier` (generated from `output_schema`) |

The other LLM steps answer through one structured-output function call instead of a tool loop:

| Function | Node |
|---|---|
| `RouteChoice` | `route_intent` |
| `SafetyVerdict` | `injection_guard` |
| `AnalysisContinuity` | `grant_judge` |
| `ModelDraft` | `author` (or one fenced SQL block, since GPT-OSS can't be forced to call it) |
| `ModelReview` | `review` |
| `ImpactReport` | `report` |

Tool-loop budgets (`max_rounds`): `analyze` 8, `consult` 6, `repository` 10,
`search` 6, `investigate` 24.

#### 5. Wire it together

```python
builder = StateGraph(TurnState, context_schema=TurnContext,
                     input_schema=TurnInput, output_schema=TurnOutput)
# ... add_node for each step above, retry_policy=LLM_RETRY on model nodes
builder.add_edge(START, "screen_input")
builder.add_edge(["route_intent", "injection_guard", "recall_memories",
                  "summarize_history"], "policy_gate")           # join
builder.add_conditional_edges("dispatch", Dispatcher.select, specialists.path_map())
for name, node in specialists.entries.values():
    builder.add_node(name, node)
    builder.add_conditional_edges(name, after_specialist, ["screen_input", "capture_memory"])
builder.add_edge("capture_memory", "screen_output")
builder.add_edge("screen_output", END)
graph = builder.compile(checkpointer=checkpointer, store=store, name="migration_assistant")
```

`TurnRunner` calls `aget_state` first. A thread paused on `interrupt()` is
resumed with `Command(resume=...)`, and any other turn starts with
`TurnInput`. Every run uses `durability="exit"`, `recursion_limit=100` and
`max_concurrency=MAX_PARALLEL_TASKS` (default 3).

#### Handling errors

| Error type | Who fixes it | How it is handled here |
|---|---|---|
| Transient (throttling, timeouts, 5xx) | System | `LLM_RETRY = RetryPolicy(max_attempts=3, initial_interval=1.0, backoff_factor=2.0, retry_on=is_transient)` on every node that calls the model directly, and on the tool loop's `model` node |
| LLM-recoverable | The LLM | Error stored in State and looped back: `invoke_structured` returns a parse error to the model (3 tries); `validate`/`review` send `feedback` to `author` (3 author attempts in total); `evidence_gate` sends `investigate` back once for each reason; the tool loop `nudge`s (at most 2) |
| User-fixable | The user | `interrupt()` in `clarify`, `ask_sources`, `ask_user`; the next message resumes the thread |
| Recoverable after retries | Developer (`error_handler`) | Not used in this graph |
| Unexpected | Developer | Bubbles up to the turn handler (for example `StructuredOutputError`) |

### LangGraph components used

| Component | Where it is used |
|---|---|
| `StateGraph` + reducers | `TurnState` is the turn graph's state; `latest` and `operator.add` reducers merge parallel writes |
| `input_schema` / `output_schema` | `TurnInput` in, `TurnOutput` out; the rest of the state stays internal |
| `context_schema` + `Runtime` | `TurnContext` carries the message, files, user, backend gateway and logger; it is never checkpointed |
| `START` / `END` | Entry and exit of every graph and subgraph |
| `add_edge` | Fixed steps, and the join `[route_intent, injection_guard, recall_memories, summarize_history] → policy_gate` |
| `Command(goto=...)` | Routing from inside a node: `screen_input` fan-out, `policy_gate`, `grant_judge`, analyst, gates, author/validate/review |
| `add_conditional_edges` | `dispatch` → specialist, `after_specialist`, the tool loop |
| Subgraphs | `generate`, `impact`, `history`, `build_model`, and every tool loop are compiled graphs used as nodes |
| `Send` | One `build_model` run per target file, in parallel (map-reduce) |
| `ToolNode` | Runs agent tools; `guard_tool_call` screens and caps every result |
| `interrupt()` + `Command(resume)` | `clarify`, `ask_sources`, `ask_user` pause for the user; the next message resumes |
| `RetryPolicy` | `LLM_RETRY` on every model node |
| Checkpointer | `DynamoDBSaver`: one thread per chat, one write per turn (`durability="exit"`), 30-day TTL |
| Store | `DynamoDBStore`: long-term memory per user, read by `recall_memories`, written by `capture_memory` |
| Config | `recursion_limit=100`, `max_concurrency`, callbacks for token usage and LangSmith tracing |

### Inside the subgraphs

**generate** — plan the models, build each one in parallel, publish the files:

```mermaid
flowchart LR
    S(["START"]) --> AN["analyze<br/>Requirements Analyst<br/>tool loop"]
    AN -- "unclear" --> CL["clarify<br/>interrupt()"]
    AN -- "targets" --> PB["plan_builds"]
    AN -- "nothing to build" --> PUB
    PB -- "Send × N" --> BM[["build_model"]]
    BM --> PUB["publish<br/>files + reply"]
    CL --> E(["END"])
    PUB --> E
```

**build_model** — one per target file; errors go back to the author until the
revision budget is spent:

```mermaid
flowchart LR
    S(["START"]) --> AU["author<br/>LLM"]
    AU --> VA["validate<br/>sqlglot static checks"]
    VA -- "rejected" --> AU
    VA -- "passed" --> RV["review<br/>LLM · 12-point checklist"]
    RV -- "defects" --> AU
    RV -- "approved or budget spent" --> FI["finish"]
    VA -- "budget spent" --> FI
    FI --> E(["END"])
```

**impact** — evidence only from sources the user confirmed:

```mermaid
flowchart LR
    S(["START"]) --> PS["plan_sources<br/>backend grant"]
    PS -- "not confirmed" --> AS["ask_sources<br/>interrupt()"]
    PS -- "confirmed" --> INV["investigate<br/>Evidence Investigator<br/>tool loop"]
    INV --> EG{"evidence_gate"}
    EG -- "read more · once" --> INV
    EG -- "grounded" --> RP["report<br/>Impact Reporter · LLM"]
    EG -- "needs the user" --> AU["ask_user<br/>interrupt()"]
    RP --> FI["finish"]
    AS --> E(["END"])
    AU --> E
    FI --> E
```

**history** — finding a file and handing it over are separate steps:

```mermaid
flowchart LR
    S(["START"]) --> SE["search<br/>History Agent<br/>tool loop"]
    SE --> DG{"delivery_gate"}
    DG -- "requested by id" --> DF["deliver_files"]
    DG -- "asked for, only named" --> LF["locate_file"]
    DG -- "no file wanted" --> E(["END"])
    LF -- "name matched, newest version" --> DF
    LF -- "no name or no match" --> E
    DF --> E
```

The model often names the file instead of calling the delivery tool, so
`delivery_gate` spots the request and `locate_file` resolves the name against
the user's own files. When several versions share that name, the newest is
handed over. The file content never enters the model's context.

**tool loop** — every agent that uses tools (analyst, consultant, repository,
history search, evidence investigator) is this small compiled graph, run
without a checkpointer:

```mermaid
flowchart LR
    S(["START"]) --> MO["model<br/>LLM"]
    MO -- "tool calls" --> TN["tools<br/>ToolNode"]
    TN -- "more to do" --> MO
    TN -- "submit_* result recorded" --> E(["END"])
    MO -- "no answer yet" --> NU["nudge"]
    NU --> MO
    MO -- "answered" --> E
```

### The agents

| Agent | Node | Tools (all read-only) |
|---|---|---|
| Router Agent | `route_intent` | — |
| Injection Guard | `injection_guard` | — |
| Summarizer | `summarize_history` | — (condenses a long chat's older turns) |
| Grant Judge | `grant_judge` | — |
| Migration Consultant | `consult` | `list_files`, `get_file_content`, `remember`, `forget` |
| Repository Agent | `repository` | `github_connection_status`, `list_github_repositories`, `list_github_files`, `read_github_file` |
| History Agent | `history` → `search` | `search_chat_history`, `search_chat_files`, `request_file_delivery` (delivered by `attach_chat_file`) |
| Requirements Analyst | `generate` → `analyze` | GitHub tools, `submit_migration_spec` |
| Model Author | `build_model` → `author` | — (one per target model) |
| Model Reviewer | `build_model` → `review` | — |
| Evidence Investigator | `impact` → `investigate` | `read_impact_evidence`, `submit_evidence_dossier` |
| Impact Reporter | `impact` → `report` | — |

Tool names are part of the activity-log contract: the admin AI log and the
release checks key on them. `generate_output`, `attach_chat_file` and
`impact_analysis_agent` also appear in the log for a published file, a file
handed over from an earlier chat, and an impact analysis.

## Supported File Types

| Category | Description | Example |
|----------|-------------|---------|
| Template | Field requirements and nullability rules | `contractAdditionalInformation_template.csv` |
| Mapping | Source-to-target field mappings | `mapping_document.csv` |
| ADD_INFO | DBT transformation model | `AMS_AI_DBT_ADD_INFO.sql` |
| STG | DBT staging model | `AMS_AI_DBT_STG_ADD_INFO.sql` |

## Deployment

The [AWS business-hours policy](docs/AWS_Business_Hours.md) schedules public access
for weekdays 8:30 am–7 pm in New Zealand, with compute shutdown overnight and
on weekends. Deployments use an expiring maintenance hold.

Deployment is automated. Pushing to `main` runs CI, builds the three images,
scans them, deploys, and smoke-tests — see [CI/CD](#cicd). There is no manual
build or `aws cloudformation deploy` step.

```bash
# Watch the current deploy
gh run watch

# What is running right now
aws ecs describe-services --cluster circini-demo \
  --services frontend backend ai-service \
  --query 'services[].{Name:serviceName,Running:runningCount,TaskDef:taskDefinition}' \
  --output table

# Verify the deployment and its security controls at any time
./deploy/smoke-test.sh
```

### Rollback

Every commit's images stay in ECR, so rolling back is redeploying an earlier
tag — no rebuild:

```bash
gh workflow run deploy.yml -f image_tag=sha-abc1234
```

Rollback is **manual**. Services run `MinimumHealthyPercent: 100` /
`MaximumPercent: 200`, so a failing new task never displaces a healthy one and
the old revision keeps serving; the job then fails at `aws ecs wait
services-stable`. ECS is not configured with a deployment circuit breaker, so
it does not revert the task definition by itself — redeploy the last good tag
with the command above.

### Infrastructure

Four CloudFormation stacks in `deploy/aws/`, deployed in order by the pipeline:

| Stack | Contents |
|---|---|
| `circini-network` | VPC, subnets, security groups, NAT gateway |
| `circini-data` | RDS PostgreSQL 16, Secrets Manager entries (`circini/*`) |
| `circini-cognito` | User pool, SPA client, groups `admin` / `analyst` / `auditor` |
| `circini-app` | ECS cluster, services, task definitions, ALB, S3 audit archive |

A fifth stack, `circini-github-oidc`, holds the `circini-github-deploy` role
the pipeline assumes. Stacks are idempotent — an unchanged template is a no-op.
