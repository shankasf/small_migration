# Circini Migration Agent

AI-powered DBT/SQL data migration assistant with a ChatGPT-like interface for analyzing mapping documents and generating Snowflake-compatible DBT models.

## Tech Stack

- **Frontend**: React 18, Vite, TypeScript, TailwindCSS, Socket.IO client, React Markdown, React Syntax Highlighter
- **Backend**: Node.js, Express, TypeScript, Prisma, PostgreSQL, Socket.IO, Multer (file uploads)
- **AI Service**: Python, FastAPI, OpenAI Agents SDK, OpenAI Whisper (speech-to-text via `gpt-4o-transcribe`)
- **Database**: PostgreSQL
- **Deployment**: Kubernetes (K3s), Docker, Traefik, cert-manager

## Architecture

```
Frontend (React/Vite)      Backend (Express)         AI Service (FastAPI)
    :5173            --->      :3001            --->      :8084
                                  |                          |
                                  v                          v
                            PostgreSQL               OpenAI API
                            (Prisma ORM)             (Agents SDK + Whisper)
                                                     PersistentVolume (/data/outputs)
```

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

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/health | Health check |
| POST | /api/sessions | Create session |
| GET | /api/sessions | List sessions |
| GET | /api/sessions/:id | Get session with messages |
| DELETE | /api/sessions/:id | Delete session |
| POST | /api/chat/:id/messages | Send message (proxies to AI) |
| POST | /api/files/:id/upload | Upload files to session |
| GET | /api/files/output/:id/download | Download generated output |

### AI Service (port 8084)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /ai/health | Health check |
| POST | /ai/chat | Process message with migration agent |
| GET | /ai/status/:id | Get session file status |
| POST | /ai/reset/:id | Reset session state and agent |
| POST | /ai/stt | Transcribe audio to text (Whisper) |

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

