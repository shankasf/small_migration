# Data Migration Agent

A full-stack application for AI-powered DBT/SQL data migrations with a ChatGPT-like interface.

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
├── backend/            # Node.js + Express + Prisma
├── ai-service/         # Python FastAPI (migration agent logic)
├── kubernetes/         # K8s deployment manifests
├── sample_files/       # Sample migration files for testing
├── output/             # Generated files storage
├── app.py              # Legacy Streamlit UI (still available)
└── agent.py            # Original agent logic (referenced by ai-service)
```

## Features

- **Chat Interface**: ChatGPT-like UI with conversation history
- **Session Management**: Create, switch, and delete chat sessions
- **File Upload**: Drag & drop support for template, mapping, and DBT files
- **AI-Powered Migration**: Analyze files and generate updated DBT models
- **Download Generated Files**: Export updated SQL files

## Local Development

### Prerequisites

- Node.js 20+
- Python 3.12+
- PostgreSQL 15+ (running on localhost)

### 1. Start AI Service

```bash
cd ai-service
source venv/bin/activate
uvicorn main:app --port 8084 --reload
```

### 2. Start Backend

```bash
cd backend
npm run dev
```

### 3. Start Frontend

```bash
cd frontend
npm run dev
```

### 4. Access Application

Open http://localhost:5173

## Environment Variables

### Backend (backend/.env)
```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/migration_agent?schema=public"
AI_SERVICE_URL="http://localhost:8084"
PORT=3001
CORS_ORIGIN="http://localhost:5173"
```

### AI Service (ai-service/.env)
```env
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=gpt-5.2
PORT=8084
OUTPUT_DIR=/home/ubuntu/apps/small_migration/output
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
| POST | /ai/chat | Process message |
| GET | /ai/status/:id | Get migration status |
| POST | /ai/reset/:id | Reset session |

## Usage

1. **Create a new chat** - Click "New Chat" in the sidebar
2. **Upload files** - Drop your template, mapping, and DBT files
3. **Ask questions** - "Analyze the template" or "What mappings are available?"
4. **Generate files** - "Generate the updated DBT models"
5. **Download outputs** - Click download buttons for generated SQL files

## File Types

| Category | Description | Example |
|----------|-------------|---------|
| Template | Field requirements | contractAdditionalInformation_template.csv |
| Mapping | Source-to-target mappings | mapping_document.csv |
| ADD_INFO | DBT transformation model | AMS_AI_DBT_ADD_INFO.sql |
| STG | DBT staging model | AMS_AI_DBT_STG_ADD_INFO.sql |

## Legacy Streamlit UI

The original Streamlit UI is still available:

```bash
source venv/bin/activate
streamlit run app.py
```

Access at http://localhost:8501

## Tech Stack

- **Frontend**: React 18, Vite, TypeScript, TailwindCSS
- **Backend**: Node.js, Express, Prisma, PostgreSQL
- **AI Service**: Python, FastAPI, OpenAI Agents SDK
- **Deployment**: K3s, Traefik, cert-manager

## Agent Tools

The migration agent has access to these tools:

| Tool | Description |
|------|-------------|
| `read_template_file` | Parse template requirements |
| `read_mapping_document` | Extract source-target mappings |
| `read_dbt_add_info_model` | Analyze ADD_INFO model |
| `read_dbt_stg_add_info_model` | Analyze STG model |
| `generate_updated_dbt_add_info` | Create updated ADD_INFO |
| `generate_updated_dbt_stg_add_info` | Create updated STG |
| `generate_analysis_report` | Create migration report |
| `get_migration_status` | Check progress |

## Troubleshooting

- **API Key Error**: Ensure `OPENAI_API_KEY` is set in ai-service/.env
- **Database Error**: Ensure PostgreSQL is running and database exists
- **Port Conflicts**: Check ports 3001, 5173, 8084 are available
