# Circini Migration Agent

An AI-powered DBT/SQL data migration assistant with a ChatGPT-like interface. Upload your mapping documents, templates, and existing DBT models — then chat with the agent to analyze, generate, and download updated Snowflake-compatible DBT models.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  React Frontend │────▶│ Node/Express    │────▶│ Python AI       │
│  Port: 5173     │     │ Port: 3001      │     │ Port: 8084      │
└─────────────────┘     └─────────────────┘     └─────────────────┘
                               │                        │
                               ▼                        ▼
                        ┌─────────────────┐     ┌─────────────────┐
                        │  PostgreSQL     │     │ PersistentVolume│
                        │  Port: 5432     │     │ /data/outputs   │
                        └─────────────────┘     └─────────────────┘
```

## Project Structure

```
small_migration/
├── frontend/           # React + Vite + TypeScript (ChatGPT-like UI)
├── backend/            # Node.js + Express + Prisma + Socket.IO
├── ai-service/         # Python FastAPI (migration agent + STT)
│   ├── routes/
│   │   ├── migration.py    # Chat & migration endpoints
│   │   └── stt.py          # Speech-to-text (Whisper)
│   ├── utils/
│   │   └── realtime_logger.py
│   └── config.py
├── kubernetes/         # K8s deployment manifests
├── sample_files/       # Sample migration files for testing
├── output/             # Generated files storage (local dev)
└── app.py              # Legacy Streamlit UI (still available)
```

## Features

- **Chat Interface**: ChatGPT-like UI with persistent conversation history
- **Session Management**: Create, switch, search, and delete chat sessions with resizable sidebar
- **File Upload**: Attach up to 10 files per message (CSV, XLSX, SQL, JSON, YAML, and more)
- **Voice Input**: Record audio directly in the chat — transcribed via OpenAI Whisper (`gpt-4o-transcribe`)
- **AI Migration Agent**: Analyze templates and mapping documents, then generate complete Snowflake-compatible DBT models
- **Realtime Logs**: Live status updates streamed from the AI service during processing
- **Download Generated Files**: Export updated SQL files directly from chat messages
- **Session TTL**: In-memory sessions auto-evict after 1 hour of inactivity (max 50 concurrent)

## Local Development

### Prerequisites

- Node.js 20+
- Python 3.12+
- PostgreSQL 15+ (running on localhost)

### Quick Start (all services)

```bash
./start-dev.sh
```

This starts all three services simultaneously and prints their URLs.

### Manual Start

#### 1. Start AI Service

```bash
cd ai-service
source venv/bin/activate
uvicorn main:app --port 8084 --reload
```

#### 2. Start Backend

```bash
cd backend
npm run dev
```

#### 3. Start Frontend

```bash
cd frontend
npm run dev
```

#### 4. Access Application

Open http://localhost:5173

## Environment Variables

### Backend (`backend/.env`)
```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/migration_agent?schema=public"
AI_SERVICE_URL="http://localhost:8084"
PORT=3001
CORS_ORIGIN="http://localhost:5173"
```

### AI Service (`ai-service/.env`)
```env
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=gpt-5.2
PORT=8084
OUTPUT_DIR=/home/ubuntu/apps/small_migration/output
BACKEND_URL=http://localhost:3001
```

## Kubernetes Deployment

Deploy to K3s at migration.callsphere.tech:

```bash
# Build and push images
docker build -t migration-agent-frontend:latest ./frontend
docker build -t migration-agent-backend:latest ./backend
docker build -t migration-agent-ai:latest ./ai-service

# Apply manifests
kubectl apply -f kubernetes/deployment.yaml

# Check status
kubectl get pods -n migration-agent
```

## API Endpoints

### Backend (port 3001)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/health | Health check |
| POST | /api/sessions | Create session |
| GET | /api/sessions | List sessions |
| GET | /api/sessions/:id | Get session |
| DELETE | /api/sessions/:id | Delete session |
| POST | /api/chat/:id/messages | Send message |
| POST | /api/files/:id/upload | Upload files |
| GET | /api/files/output/:id/download | Download output |

### AI Service (port 8084)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /ai/health | Health check |
| POST | /ai/chat | Process message with agent |
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

## Usage

1. **Create a new chat** — Click "New chat" in the sidebar or start typing on the welcome screen
2. **Upload files** — Click the paperclip icon to attach template, mapping, ADD_INFO, and STG files
3. **Use voice input** — Click the mic icon to dictate your question (transcribed automatically)
4. **Ask questions** — "Analyze the template" or "What mappings are available?"
5. **Generate files** — "Generate the updated DBT models"
6. **Download outputs** — Click download buttons attached to the AI response

## Supported File Types

| Category | Description | Example |
|----------|-------------|---------|
| Template | Field requirements & nullability rules | `contractAdditionalInformation_template.csv` |
| Mapping | Source-to-target field mappings | `mapping_document.csv` |
| ADD_INFO | DBT transformation model | `AMS_AI_DBT_ADD_INFO.sql` |
| STG | DBT staging model | `AMS_AI_DBT_STG_ADD_INFO.sql` |

File extensions accepted: `.csv`, `.xlsx`, `.xls`, `.txt`, `.sql`, `.json`, `.xml`, `.md`, `.py`, `.js`, `.ts`, `.yaml`, `.yml`, `.log`

## Tech Stack

- **Frontend**: React 18, Vite, TypeScript, TailwindCSS, Socket.IO client, Lucide icons
- **Backend**: Node.js, Express, Prisma, PostgreSQL, Socket.IO, Multer
- **AI Service**: Python, FastAPI, OpenAI Agents SDK, OpenAI Whisper (STT)
- **Deployment**: K3s, Traefik, cert-manager

## Legacy Streamlit UI

The original Streamlit UI is still available for quick local testing:

```bash
source venv/bin/activate
streamlit run app.py
```

Access at http://localhost:8501

## Troubleshooting

- **API Key Error**: Ensure `OPENAI_API_KEY` is set in `ai-service/.env`
- **Database Error**: Ensure PostgreSQL is running and the database exists; run `cd backend && npx prisma db push` to sync the schema
- **Port Conflicts**: Check ports 3001, 5173, and 8084 are available
- **Voice not working**: Browser microphone permission must be granted; HTTPS required in production
- **Session lost after restart**: Files are re-hydrated from the database on the next message automatically
