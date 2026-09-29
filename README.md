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

### Complete flow: input to output

Every box is a LangGraph node. Solid arrows are edges; the labels name the
LangGraph mechanism that takes the turn there.

```mermaid
flowchart TD
    IN(["INPUT: POST /ai/chat<br/>message · files · history · user"])
    IN --> RUN["TurnRunner<br/>request goes into Runtime context,<br/>never into checkpointed state"]
    RUN --> LOAD[("Checkpointer: DynamoDBSaver<br/>aget_state(thread_id)")]
    LOAD --> Q{"thread paused<br/>on interrupt()?"}
    Q -- "no: ainvoke(TurnInput)" --> S0
    Q -- "yes: ainvoke(Command(resume))" --> PAUSED["paused node re-runs<br/>and sets rerun = true"]

    subgraph TURN["StateGraph migration_assistant · state TurnState"]
        S0(["START"]) --> SI["screen_input<br/>guardrails in"]
        SI -- "Command(goto=END) · blocked" --> E0(["END"])
        SI -- "Command(goto=[4 nodes]) · parallel" --> RT["route_intent<br/>Router · LLM"]
        SI --> IG["injection_guard<br/>LLM"]
        SI --> RM["recall_memories<br/>Store search"]
        SI --> SUM["summarize_history<br/>LLM"]
        RT --> PG{"policy_gate<br/>join of all 4"}
        IG --> PG
        RM --> PG
        SUM --> PG
        PG -- "Command(goto=END) · flagged" --> E0
        PG -- "impact on a confirmed grant" --> GJ["grant_judge<br/>LLM"]
        PG --> DI{"dispatch<br/>conditional edge on route"}
        GJ --> DI
        DI -- generate --> GEN[["generate<br/>subgraph"]]
        DI -- impact --> IMP[["impact<br/>subgraph"]]
        DI -- history --> HIS[["history<br/>subgraph"]]
        DI -- consult --> CON["consult<br/>tool loop"]
        DI -- repository --> REP["repository<br/>tool loop"]
        DI -- out_of_scope --> SG["scope_guard<br/>no LLM"]
        GEN --> AS{"after_specialist"}
        IMP --> AS
        HIS --> AS
        CON --> AS
        REP --> AS
        SG --> AS
        AS -- "rerun: a question was answered" --> SI
        AS --> CM["capture_memory<br/>Store put"]
        CM --> SO["screen_output<br/>guardrails out"]
        SO --> E0
    end

    PAUSED --> AS
    GEN -. "interrupt(): ask the user" .-> SAVE
    IMP -. "interrupt(): ask the user" .-> SAVE
    E0 --> SAVE[("Checkpoint written once<br/>durability = exit")]
    SAVE --> OUT(["OUTPUT: TurnResult<br/>reply · files · usage · paused?"])

    classDef llm fill:#dbeafe,stroke:#2563eb,color:#0f172a
    classDef code fill:#dcfce7,stroke:#16a34a,color:#0f172a
    classDef sub fill:#fef3c7,stroke:#d97706,color:#0f172a
    class RT,IG,SUM,GJ,CON,REP llm
    class SI,RM,PG,DI,SG,AS,CM,SO code
    class GEN,IMP,HIS sub
```

Blue nodes call the model, green nodes are plain code, amber nodes are compiled
subgraphs (below). No model decides whether a guardrail applies, whose files are
read, or what reaches the user.

When a specialist needs an answer from the user (a missing base model, which
evidence sources to use), it calls `interrupt()`. The run stops, the checkpoint
is saved, and the question is the reply. The user's next message resumes the
thread with `Command(resume=...)`, then goes back through `screen_input` so it is
screened and routed like any other message.

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
    LF -- "one match" --> DF
    LF -- "none or several" --> E
    DF --> E
```

The model often names the file instead of calling the delivery tool, so
`delivery_gate` spots the request and `locate_file` resolves the name against
the user's own files. Ambiguity is never guessed at, and the file content never
enters the model's context.

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
