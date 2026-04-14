# Circini Migration Agent — Architecture Document

> **Version**: 1.0 | **Date**: April 14, 2026  
> **Domain**: https://migration.callsphere.tech  
> **Repository**: https://github.com/shankasf/E-Commerce-Voice-Agent.git

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)  
2. [Current Architecture Overview](#2-current-architecture-overview)  
3. [System Design Flowcharts — Current](#3-system-design-flowcharts--current)  
4. [Software & Technology Stack](#4-software--technology-stack)  
5. [Data Flow](#5-data-flow)  
6. [Data at Rest / Storage](#6-data-at-rest--storage)  
7. [Hosting & Infrastructure](#7-hosting--infrastructure)  
8. [Security](#8-security)  
9. [AI Agent Design](#9-ai-agent-design)  
10. [API Surface](#10-api-surface)  
11. [Monitoring & Observability](#11-monitoring--observability)  
12. [Known Limitations](#12-known-limitations)  
13. [Scalable Architecture Plan](#13-scalable-architecture-plan)  
14. [System Design Flowcharts — Scalable](#14-system-design-flowcharts--scalable)  
15. [Migration Roadmap: Current to Scalable](#15-migration-roadmap-current-to-scalable)

---

## 1. Executive Summary

The **Circini Migration Agent** is an AI-powered assistant that generates Snowflake-compatible DBT models for contract data migrations (CLM to AMS). Users upload mapping documents, templates, and reference SQL through a ChatGPT-like interface, and the agent produces complete, validated dbt SQL models.

| Tier | Technology | Role |
|------|-----------|------|
| **Frontend** | React 18 + Vite + TypeScript | Chat UI, file upload, real-time logs |
| **Backend** | Node.js + Express + Prisma | REST API, session management, file storage |
| **AI Service** | Python FastAPI + OpenAI Agents SDK | LLM orchestration, SQL generation |

All three run as containers in a Kubernetes (K3s) cluster, fronted by Traefik with TLS.

---

## 2. Current Architecture Overview

```mermaid
graph TB
    User["User Browser"] -->|HTTPS| Traefik["Traefik Ingress<br/>TLS: Let's Encrypt<br/>Host: migration.callsphere.tech"]

    subgraph K3s["Kubernetes Cluster (K3s) — Namespace: migration-agent"]
        Traefik -->|"/* route"| Frontend["Frontend<br/>React 18 + Vite<br/>Nginx :5173"]
        Traefik -->|"/api/* route"| Backend["Backend<br/>Express.js + Prisma<br/>Socket.IO :3001"]
        Backend -->|"POST /ai/chat"| AI["AI Service<br/>FastAPI + OpenAI Agents<br/>Uvicorn :8084"]
        AI -->|"POST /api/logs"| Backend
        Backend -->|"Socket.IO"| Frontend
    end

    Backend -->|TCP :5432| DB[("PostgreSQL<br/>External<br/>72.62.162.83")]
    AI -->|HTTPS| OpenAI["OpenAI API<br/>gpt-5.2 | gpt-4o-transcribe"]
    AI -->|R/W| PV[("PersistentVolume<br/>/data/outputs<br/>10Gi")]

    style K3s fill:#f0f4ff,stroke:#3b82f6
    style DB fill:#fef3c7,stroke:#f59e0b
    style OpenAI fill:#d1fae5,stroke:#10b981
    style PV fill:#fce7f3,stroke:#ec4899
```

---

## 3. System Design Flowcharts — Current

### 3.1 High-Level Request Flow

```mermaid
sequenceDiagram
    participant U as User Browser
    participant T as Traefik Ingress
    participant B as Backend (Express)
    participant A as AI Service (FastAPI)
    participant O as OpenAI API
    participant DB as PostgreSQL

    U->>T: HTTPS Request
    T->>B: /api/* routes
    T->>U: /* static (Nginx)
    B->>DB: Read/Write sessions, messages, files
    B->>A: POST /ai/chat (message + files + history)
    A->>O: Agent call (gpt-5.2 + tools)
    O-->>A: LLM response + tool calls
    A-->>B: HTTP POST /api/logs (real-time)
    B-->>U: Socket.IO log stream
    A-->>B: Final response + generated outputs
    B->>DB: Save assistant message + outputs
    B-->>U: JSON response
```

### 3.2 File Upload and Chat Message Flow

```mermaid
sequenceDiagram
    participant U as User
    participant FE as Frontend
    participant BE as Backend
    participant AI as AI Service
    participant OAI as OpenAI API
    participant DB as PostgreSQL

    Note over U,DB: FILE UPLOAD
    U->>FE: Select/drag files
    FE->>BE: POST /api/files/{sessionId}/upload (multipart)
    BE->>BE: Parse via Multer (XLSX→CSV)
    BE->>DB: INSERT UploadedFile (content as TEXT)
    BE-->>FE: Return file IDs
    FE-->>U: Upload confirmed

    Note over U,DB: SEND MESSAGE
    U->>FE: Type message + send
    FE->>BE: POST /api/chat/{sessionId}/messages
    BE->>DB: INSERT Message (role=user)
    BE->>AI: POST /ai/chat {session_id, message, files, history}
    AI->>OAI: Agent run (system prompt + tools + conversation)
    
    loop Real-time Progress
        AI-->>BE: HTTP POST /api/logs/{sid}
        BE-->>FE: Socket.IO emit('log')
        FE-->>U: Live progress (thinking, generating...)
    end

    OAI-->>AI: LLM response
    AI->>AI: generate_output() → save SQL to disk
    AI-->>BE: {response, new_outputs[]}
    BE->>DB: INSERT Message (role=assistant) + GeneratedOutput
    BE-->>FE: JSON response
    FE-->>U: Render markdown + download links

    Note over U,DB: DOWNLOAD OUTPUT
    U->>FE: Click download
    FE->>BE: GET /api/files/output/{id}/download
    BE->>DB: SELECT content FROM GeneratedOutput
    BE-->>FE: File stream
    FE-->>U: .sql file saved
```

### 3.3 Speech-to-Text Flow

```mermaid
sequenceDiagram
    participant U as User
    participant FE as Frontend
    participant BE as Backend
    participant AI as AI Service
    participant OAI as OpenAI API

    U->>FE: Click mic, speak
    FE->>FE: MediaRecorder captures WebM blob
    FE->>BE: POST /api/stt (multipart audio)
    BE->>AI: POST /ai/stt (proxy FormData)
    AI->>OAI: Whisper API (gpt-4o-transcribe)
    OAI-->>AI: Transcribed text
    AI-->>BE: {text: "..."}
    BE-->>FE: Transcription
    FE-->>U: Text populated in input box
```

### 3.4 Real-Time Log Streaming

```mermaid
sequenceDiagram
    participant AI as AI Service
    participant BE as Backend
    participant FE as Frontend (useRealtimeLogs)

    AI->>BE: HTTP POST /api/logs/{sessionId}<br/>{step, message, type, data}
    BE->>FE: Socket.IO emit('log') to room session:{sid}
    FE->>FE: Render log (info=blue, success=green, error=red, thinking=pulse)

    Note over AI,FE: Repeats for each agent step:<br/>thinking → reading files → generating SQL → validating
```

---

## 4. Software & Technology Stack

### 4.1 Frontend

| Software | Version | Purpose |
|----------|---------|---------|
| React | 18.2 | UI framework |
| Vite | 5.x | Build tool and dev server |
| TypeScript | 5.3 | Type-safe JavaScript |
| TailwindCSS | 3.4 | Utility-first CSS |
| Socket.IO Client | 4.8 | WebSocket for real-time logs |
| Axios | 1.6.5 | HTTP client |
| react-markdown | 9.0 | Markdown rendering in chat |
| react-syntax-highlighter | 15.5 | SQL/code syntax highlighting |
| lucide-react | 0.312 | Icon library |
| Nginx | alpine | Production static server |

### 4.2 Backend

| Software | Version | Purpose |
|----------|---------|---------|
| Node.js | 20 LTS | JavaScript runtime |
| Express | 4.18 | HTTP framework |
| TypeScript | 5.3 | Type safety |
| Prisma | 5.9 | ORM and migrations |
| Socket.IO | 4.8 | WebSocket server |
| Multer | 1.4 | File upload handling |
| XLSX | 0.18 | Excel file parsing |
| UUID | 9.0 | ID generation |
| Axios | 1.6 | HTTP client (to AI service) |
| cors | 2.8 | CORS middleware |

### 4.3 AI Service

| Software | Version | Purpose |
|----------|---------|---------|
| Python | 3.12 | Runtime |
| FastAPI | 0.109 | Async web framework |
| Uvicorn | 0.27 | ASGI server |
| OpenAI Agents SDK | 0.0.7 | Agent orchestration with tool use |
| Pandas | 2.1.4 | CSV/data parsing |
| HTTPX | 0.27 | Async HTTP client |
| Pydantic | 2.10 | Data validation |

### 4.4 Database and Infrastructure

| Software | Purpose |
|----------|---------|
| PostgreSQL 15+ | Relational database |
| Docker | Container runtime (multi-stage builds) |
| Kubernetes (K3s) | Container orchestration |
| Traefik | Ingress controller and reverse proxy |
| cert-manager + Let's Encrypt | Automatic TLS certificates |

### 4.5 External APIs

| Service | Model | Purpose |
|---------|-------|---------|
| OpenAI API | `gpt-5.2-2025-12-11` | Main LLM for SQL generation |
| OpenAI API | `gpt-4o-transcribe` | Speech-to-text |
| AWS SES | `us-east-1` | Email (configured, unused) |

---

## 5. Data Flow

### 5.1 Write, Process, Read Paths

```mermaid
graph LR
    subgraph Write["Write Path (User → System)"]
        M1["Chat message"] -->|"INSERT"| DB1["Message table"]
        M2["File upload"] -->|"INSERT"| DB2["UploadedFile table"]
        M3["Audio recording"] -->|"Whisper API"| M1
    end

    subgraph Process["Processing Path"]
        BE["Backend collects<br/>message + files + history"] --> AI["AI Service<br/>hydrates agent tools"]
        AI --> OAI["OpenAI gpt-5.2<br/>runs agent with<br/>4 tools"]
        OAI --> AI
    end

    subgraph Read["Read Path (System → User)"]
        R1["Message table"] --> C1["Chat bubble<br/>(markdown)"]
        R2["GeneratedOutput"] --> C2["Download link<br/>(.sql)"]
        R3["Socket.IO logs"] --> C3["Live progress panel"]
    end

    style Write fill:#dbeafe,stroke:#3b82f6
    style Process fill:#fef3c7,stroke:#f59e0b
    style Read fill:#d1fae5,stroke:#10b981
```

---

## 6. Data at Rest / Storage

### 6.1 PostgreSQL Database

| Table | Stores | Retention | Size |
|-------|--------|-----------|------|
| `Session` | Session metadata (id, name, timestamps) | Permanent | ~200 bytes/row |
| `Message` | Chat messages (user + assistant) | Cascade-deleted with session | 1-50 KB/row |
| `UploadedFile` | Full file content as TEXT | Cascade-deleted with session | 10 KB - 10 MB/row |
| `GeneratedOutput` | Generated SQL + metadata | Cascade-deleted with session | 5-100 KB/row |

**Constraints**: `UploadedFile` unique on `(sessionId, category)`, `GeneratedOutput` unique on `(sessionId, filename)`. All tables indexed on `sessionId`.

### 6.2 Other Storage

| Store | Location | Details |
|-------|----------|---------|
| PersistentVolume | `/data/outputs/{session_id}/{ts}/{file}` | 10Gi PVC, redundant copy of GeneratedOutput |
| In-Memory Cache | AI Service process | `session_storage` + `session_agents` — TTL 1hr, max 50 sessions |

### 6.3 Data Lifecycle

```mermaid
graph LR
    A["Create Session"] --> B["Upload Files"]
    B --> C["Chat Messages"]
    C --> D["Generated SQL"]
    
    A --> T1["Session table"]
    B --> T2["UploadedFile table"]
    C --> T3["Message table"]
    D --> T4["GeneratedOutput table"]
    D --> T5["/data/outputs/ (PV)"]

    DEL["Delete Session"] -->|"CASCADE"| T1
    T1 -.->|cascade| T2
    T1 -.->|cascade| T3
    T1 -.->|cascade| T4

    style DEL fill:#fecaca,stroke:#ef4444
```

---

## 7. Hosting & Infrastructure

### 7.1 Production Environment

| Component | Details |
|-----------|---------|
| **Server** | Single-node K3s cluster (Linux/Ubuntu) |
| **Domain** | `migration.callsphere.tech` |
| **TLS** | Let's Encrypt via cert-manager (auto-renewal) |
| **Ingress** | Traefik (path-based routing) |
| **Storage** | local-path provisioner, 10Gi PVC |
| **Database** | External PostgreSQL at `72.62.162.83:5432` |

### 7.2 Kubernetes Resources

| Resource | Configuration |
|----------|--------------|
| **Namespace** | `migration-agent` |
| **Deployments** | frontend (1 replica, :5173), backend (1 replica, :3001), ai-service (1 replica, :8084) |
| **Services** | 3x ClusterIP |
| **Ingress** | `/api/*` and `/socket.io/*` → backend, `/*` → frontend |
| **PVC** | `outputs-pvc` 10Gi (local-path) |
| **ConfigMap** | `migration-agent-config` (OPENAI_MODEL, OUTPUT_DIR, AI_SERVICE_URL, CORS_ORIGIN) |
| **Secret** | `migration-agent-secret` (OPENAI_API_KEY, DATABASE_URL) |

### 7.3 Network Topology

```mermaid
graph TB
    Internet["Internet"] -->|"HTTPS 443"| Traefik["Traefik Ingress<br/>TLS Termination"]
    
    subgraph K3s["K3s Cluster"]
        Traefik --> FE["Frontend<br/>Nginx"]
        Traefik --> BE["Backend<br/>Express + Socket.IO"]
        BE --> AI["AI Service<br/>FastAPI + Uvicorn"]
    end

    BE -->|"TCP 5432"| PG["PostgreSQL<br/>(External)"]
    AI -->|"HTTPS 443"| OAI["OpenAI API"]

    style K3s fill:#f0f4ff,stroke:#3b82f6
```

---

## 8. Security

### 8.1 Current Security Posture

| Layer | Status | Details |
|-------|--------|---------|
| Authentication | **None** | No login or API keys |
| Authorization | **None** | Any user can access any session |
| Transport Encryption | **Yes** | TLS via Let's Encrypt |
| CORS | **Configured** | Restricted to production domain |
| Secrets Management | **Partial** | K8s Secrets in prod; `.env` in dev |
| SQL Injection | **Protected** | Prisma uses parameterized queries |
| XSS | **Mitigated** | React auto-escapes; markdown sanitized |
| Rate Limiting | **None** | No throttling |
| Data Encryption at Rest | **None** | Unencrypted PostgreSQL |

### 8.2 Secrets Inventory

| Secret | Dev | Prod | Risk |
|--------|-----|------|------|
| `OPENAI_API_KEY` | `.env` file | K8s Secret | HIGH |
| `DATABASE_URL` | `.env` file | K8s Secret | HIGH |
| `AWS_ACCESS_KEY_ID` | `.env` file | K8s Secret | MEDIUM (unused) |
| `AWS_SECRET_ACCESS_KEY` | `.env` file | K8s Secret | MEDIUM (unused) |

### 8.3 Recommendations

1. Add JWT authentication on all endpoints
2. Tie sessions to authenticated users (session isolation)
3. Add rate limiting (10 req/min per IP)
4. Validate file MIME types, not just extensions
5. Enable audit logging for all file access
6. Encrypt data at rest (PostgreSQL TDE or encrypted volumes)
7. Rotate API keys on a schedule
8. Remove unused AWS credentials

---

## 9. AI Agent Design

### 9.1 Agent Architecture

The agent is built on the **OpenAI Agents SDK** (`openai-agents >= 0.0.7`). A single `Agent` instance is created per session, cached in memory, and reused across messages.

```mermaid
graph TB
    subgraph AgentSDK["OpenAI Agents SDK"]
        subgraph AgentInstance["Agent: MigrationAgent"]
            SP["System Prompt<br/>(~2,500 word instruction set)<br/>Role: dbt migration specialist"]
            MS["ModelSettings<br/>model: gpt-5.2<br/>reasoning.effort: low<br/>max_tokens: 16,000<br/>extra_body: {background: true}"]
        end

        subgraph Tools["4 Function Tools (per-session closure)"]
            T1["read_file(file_name, content)<br/>→ stores in session_storage.files"]
            T2["generate_output(file_name, content)<br/>→ writes to /data/outputs + session_storage.outputs"]
            T3["list_files()<br/>→ returns input + output file inventory"]
            T4["get_file_content(file_name)<br/>→ retrieves from files or outputs dict"]
        end

        Runner["Runner.run_streamed(agent, messages)<br/>Consumes stream events to completion<br/>Returns result.final_output (string)"]
    end

    SP --> Tools
    Tools --> Runner
    Runner -->|"final_output"| Response["ChatResponse<br/>{response, generated_files[]}"]

    style AgentSDK fill:#ede9fe,stroke:#8b5cf6
    style Tools fill:#fef3c7,stroke:#f59e0b
```

**Agent instantiation** (`get_or_create_agent()` in `migration.py`):
```python
Agent(
    name="MigrationAgent",
    instructions=INSTRUCTIONS,       # ~2,500 word system prompt
    model=settings.OPENAI_MODEL,     # "gpt-5.2" from env/config
    tools=tools,                     # 4 function_tool closures
    model_settings=ModelSettings(
        reasoning=Reasoning(effort="low"),  # lightweight reasoning for speed
        max_tokens=16000,
        extra_body={"background": True},    # background processing mode
    )
)
```

### 9.2 Session Management

Three in-memory dictionaries manage session state in the AI service:

| Dictionary | Key | Value | Purpose |
|-----------|-----|-------|---------|
| `session_storage` | session_id | `{"files": {}, "outputs": {}, "output_folder": None}` | File content for agent tools |
| `session_agents` | session_id | `Agent` instance | Cached agent with bound tools |
| `session_last_access` | session_id | `float` (timestamp) | TTL tracking |

**Eviction** (`_evict_stale_sessions()`, called on every storage access):
1. Delete sessions idle > `SESSION_TTL_SECONDS` (3600s / 1 hour)
2. If count > `SESSION_MAX_COUNT` (50), evict oldest by access time

**Rehydration**: When backend sends `request.files` dict, the AI service repopulates `session_storage["files"]` from the request payload (files originally persisted in PostgreSQL by the backend).

```mermaid
stateDiagram-v2
    [*] --> New: First message for session_id
    New --> Active: Agent created + tools bound

    state New {
        [*] --> EvictCheck: _evict_stale_sessions()
        EvictCheck --> CreateStorage: Init {files:{}, outputs:{}, output_folder:None}
        CreateStorage --> CreateAgent: Agent() with 4 tool closures
        CreateAgent --> CacheAgent: Store in session_agents dict
    }

    Active --> Active: Subsequent messages (reuse cached agent)
    Active --> Evicted: Idle > 1 hour (or >50 sessions)
    Evicted --> Active: New request triggers rehydration from DB
    Active --> Reset: POST /ai/reset/{session_id}
    Reset --> [*]: Delete from all 3 dicts
```

### 9.3 Tool Implementations

Each tool is a `@function_tool`-decorated closure that captures the session's storage reference:

**`read_file(file_name: str, content: str) -> str`**
- Stores `content` in `storage["files"][file_name]`
- Returns: `"File '{file_name}' loaded ({len(content)} characters)."`
- Called by agent when it processes uploaded file content from the user message

**`generate_output(file_name: str, content: str) -> str`**
- Creates output folder if needed: `/data/outputs/{session_id}/{YYYY-MM-DD_HH-MM-SS}/`
- Writes file to disk: `Path(output_folder/file_name).write_text(content)`
- Stores in `storage["outputs"][file_name]`
- Returns: `"File saved to: {saved_path}"`

**`list_files() -> str`**
- Returns formatted string: `"Input files: a.csv, b.sql\nOutput files: model.sql\nOutput folder: /path"`

**`get_file_content(file_name: str) -> str`**
- Searches `storage["files"]` first, then `storage["outputs"]`
- Returns file content or `"File '{file_name}' not found."`

### 9.4 Chat Request Processing (POST /ai/chat)

The complete flow from request to response:

```mermaid
sequenceDiagram
    participant BE as Backend
    participant EP as POST /ai/chat
    participant SS as Session Storage
    participant AG as Cached Agent
    participant RN as Runner.run_streamed()
    participant OAI as OpenAI API
    participant RL as RealtimeLogger
    participant DSK as /data/outputs (disk)

    BE->>EP: {session_id, message, files?, history?}
    EP->>SS: get_session_storage(session_id)<br/>triggers _evict_stale_sessions()
    EP->>RL: Create RealtimeLogger(session_id)

    alt request.files exists AND storage.files is empty
        EP->>SS: Hydrate: storage.files = request.files<br/>(pod restart recovery)
    end

    Note over EP: Build user message string:<br/>"[Uploaded files: a.csv, b.sql]\n[a.csv]:\n{content}\n..."

    Note over EP: Build messages list:<br/>1. Append each history entry as {role, content}<br/>2. Append current message as {role: "user"}

    EP->>SS: Snapshot existing output keys<br/>(to detect only NEW outputs)

    EP->>RL: await logger.ai_thinking("Processing your request...")
    EP->>AG: get_or_create_agent(session_id)
    EP->>RL: await logger.thinking("AI agent is analyzing...")
    EP->>RN: Runner.run_streamed(agent, messages)
    RN->>OAI: Agent execution with tools
    
    loop Agent tool calls
        OAI-->>RN: Tool call (read_file / generate_output / etc.)
        RN->>SS: Execute tool against session storage
        opt generate_output called
            RN->>DSK: Write .sql file to disk
        end
        RN-->>OAI: Tool result
    end

    OAI-->>RN: Final response text
    RN-->>EP: result.final_output

    EP->>RL: await logger.complete("Response ready")

    Note over EP: Build generated_files[]:<br/>Only outputs NOT in snapshot (new this turn)<br/>Each: {name, path, content}

    EP-->>BE: ChatResponse {response, generated_files[]}
    EP->>RL: await logger.close()
```

**Request payload** (`ChatRequest`):
```python
{
    "session_id": "uuid",
    "message": "Add field X to the staging model",
    "files": {"template.csv": "content...", "mapping.csv": "content..."},  # optional
    "history": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]  # optional
}
```

**Response payload** (`ChatResponse`):
```python
{
    "response": "Here is the updated model with field X added...",
    "generated_files": [
        {"name": "AMS_AI_DBT_STG_ADD_INFO_updated.sql", "path": "/data/outputs/.../file.sql", "content": "SELECT..."}
    ]
}
```

### 9.5 Message Construction

The backend constructs the AI service request in `chat.ts`:

1. Fetches session with uploaded files and last 20 messages (DESC order)
2. Builds `files` dict: `{filename: content}` from all `UploadedFile` rows with non-empty content
3. Reverses messages to chronological order, maps to `[{role, content}]`
4. Sends to AI service with 600-second timeout (10 minutes)

The AI service then augments the user message with file context:
```
[Uploaded files: template.csv, mapping.csv, reference_model.sql]
[template.csv]:
{full CSV content}
[mapping.csv]:
{full CSV content}
{original user message}
```

### 9.6 System Prompt (Agent Instructions)

The agent operates under a ~2,500 word instruction set with 4 sections:

**Hard Rules** (never skip):
1. Confirm base/dependency model before writing FROM clause — never guess `{{ ref('...') }}` targets
2. Never drop a CTE between regenerations — compare against previous version
3. Never truncate or omit fields — output all 50+ if needed, no `...` abbreviations
4. Never assume or fabricate context — stop and ask clarifying questions

**Workflow** (strict order):
1. Analyze all uploaded files first using `get_file_content` tool
2. Ask before assuming — flag TBD fields, datatype conflicts, ambiguous joins, unclear transforms
3. Generate dbt model following code rules
4. Run self-validation checklist

**Code Generation Rules**:

| Rule | Detail |
|------|--------|
| Source Selection | Always use `{{ ref('...') }}`, never default to base tables without explicit instruction |
| CTEs | Every source table gets its own CTE; never drop CTEs between regenerations |
| Field Propagation | Every mapped field must appear in final SELECT |
| Null Handling | `IFNULL(field, default)` to replace nulls; `NULLIF` only to convert value TO null |
| Datatype Alignment | Match template exactly; flag Boolean-vs-VARCHAR conflicts |
| Defaults | Use template defaults; NOT NULL fields must never output NULL |
| WHERE Clauses | Include filtering macros, filter to current/non-deleted rows |
| CASE Expressions | Always include ELSE branch; handle NULLs explicitly |
| Jinja Patterns | Match `{{ config() }}`, `{{ source() }}`, `{{ ref() }}` from existing models |
| MINUS/EXCEPT | Ensure both sides produce same type and default to avoid false-positive diffs |

**Self-Validation Checklist** (11 checks before output):
1. Every mapping field present in final SELECT
2. FROM/JOIN use ref models, not raw tables
3. All referenced CTEs are defined
4. Datatypes match template
5. No `NULLIF` where `IFNULL` intended
6. NOT NULL fields have defaults
7. WHERE clauses present with correct source macros
8. Row count sanity (filters implemented)
9. CASE expressions have ELSE and handle NULLs
10. No CTEs dropped from prior generation
11. Defaults consistent for MINUS/EXCEPT comparisons

### 9.7 Real-Time Logging

The `RealtimeLogger` class sends HTTP POST requests to the backend during agent execution:

```mermaid
graph LR
    AI["AI Service"] -->|"POST /api/logs/{sessionId}<br/>{step, message, type, data}"| BE["Backend :3001"]
    BE -->|"Socket.IO emit('log')<br/>to room session:{sid}"| FE["Frontend"]
    FE --> Hook["useRealtimeLogs() hook<br/>renders colored log entries"]

    style AI fill:#ede9fe,stroke:#8b5cf6
    style BE fill:#dbeafe,stroke:#3b82f6
    style FE fill:#d1fae5,stroke:#10b981
```

| Log Method | Step | Type | When Called |
|-----------|------|------|------------|
| `logger.ai_thinking(msg)` | `ai_processing` | `progress` | Start of request processing |
| `logger.thinking(msg)` | `thinking` | `thinking` | Agent begins analysis |
| `logger.complete(msg)` | `complete` | `success` | Response ready |
| `logger.error(msg)` | `error` | `error` | Exception during processing |

Logger uses `httpx.AsyncClient(timeout=5.0)` and silently catches all exceptions — logging failures never break the main agent flow.

### 9.8 Speech-to-Text

The STT endpoint (`POST /ai/stt`) accepts audio uploads and returns transcribed text:

1. Validates content type: `audio/*` or `application/octet-stream` (MediaRecorder default)
2. Maps content type to extension: webm, ogg, wav, mp4, mp3 (defaults to webm)
3. Calls `client.audio.transcriptions.create(model="gpt-4o-transcribe", file=(filename, audio_bytes))`
4. Returns `{"text": transcript.text}`

### 9.9 Backend-AI Service Integration

The backend (`aiService.ts`) wraps the AI service call with:
- **Timeout**: 600,000ms (10 minutes) for long SQL generation tasks
- **Content-Type**: `application/json`
- **Error handling**: Extracts error detail from AI service response, re-throws with context

After receiving the AI response, the backend:
1. Saves assistant message to `Message` table
2. Upserts each generated file to `GeneratedOutput` table (compound unique on `sessionId_filename`)
3. On first message, auto-names the session (first 50 chars of user message)

### 9.10 Bug Fixes in Agent Code

The codebase contains documented fixes for production issues:

| Bug | Problem | Fix |
|-----|---------|-----|
| Bug 2 | Message truncation from string concatenation | Changed to structured message list with `{role, content}` objects |
| Bug 3 | New agent created per message (lost context) | Cache agents in `session_agents` dict, reuse across messages |
| Bug 4 | All outputs returned on every response (duplicates) | Snapshot output keys before processing, only return new outputs |
| Bug 7 | Empty session after pod restart (lost files) | Hydrate `session_storage` from `request.files` when storage is empty |

---

## 10. API Surface

### 10.1 Backend REST API (Port 3001)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/sessions` | Create new session |
| `GET` | `/api/sessions` | List sessions (paginated, cursor-based) |
| `GET` | `/api/sessions/:id` | Get session with messages, files, outputs |
| `PATCH` | `/api/sessions/:id` | Rename session |
| `DELETE` | `/api/sessions/:id` | Delete session (cascade) |
| `GET` | `/api/sessions/:id/outputs` | List generated outputs |
| `POST` | `/api/chat/:sessionId/messages` | Send message (proxied to AI) |
| `GET` | `/api/chat/:sessionId/messages` | Get message history |
| `POST` | `/api/files/:sessionId/upload` | Upload files (max 10, multipart) |
| `GET` | `/api/files/:sessionId` | List uploaded files |
| `DELETE` | `/api/files/:fileId` | Delete file |
| `GET` | `/api/files/uploaded/:fileId/content` | File content as JSON |
| `GET` | `/api/files/uploaded/:fileId/download` | Download uploaded file |
| `GET` | `/api/files/output/:outputId/download` | Download generated SQL |
| `POST` | `/api/stt` | Transcribe audio (proxied to AI) |
| `GET` | `/api/health` | Health check |
| `POST` | `/api/logs/:sessionId` | Receive logs from AI service |

### 10.2 AI Service API (Port 8084)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/ai/chat` | Process message with agent |
| `GET` | `/ai/health` | Health check (model info) |
| `POST` | `/ai/reset/:sessionId` | Clear in-memory state |
| `GET` | `/ai/status/:sessionId` | Session file inventory |
| `POST` | `/ai/stt` | Transcribe audio (Whisper) |

### 10.3 WebSocket Events (Socket.IO)

| Event | Direction | Payload |
|-------|-----------|---------|
| `join-session` | Client to Server | `{ sessionId }` |
| `leave-session` | Client to Server | `{ sessionId }` |
| `log` | Server to Client | `{ timestamp, step, message, type, data }` |

---

## 11. Monitoring & Observability

| Capability | Status | Details |
|-----------|--------|---------|
| Health checks | **Yes** | `/api/health` and `/ai/health` |
| K8s probes | **Yes** | Liveness and readiness configured |
| Application logs | **Basic** | Console logs with prefixes (`[REQ]`, `[CHAT]`, `[UPLOAD]`) |
| Real-time logs | **Yes** | Agent progress streamed via Socket.IO |
| Metrics | **None** | No Prometheus/Grafana |
| Distributed tracing | **None** | No request correlation |
| Error tracking | **None** | No Sentry |
| Alerting | **None** | No PagerDuty/OpsGenie |

---

## 12. Known Limitations

| Limitation | Impact | Mitigation |
|-----------|--------|------------|
| Single replica per service | No HA, downtime on restart | Scale replicas |
| In-memory agent cache | Lost on pod restart | Rehydrated from DB |
| No authentication | Public access | Add auth before rollout |
| 50 concurrent session limit | AI service cap | Scale horizontally or add Redis |
| 10-minute request timeout | Long generations may fail | Stream partial results |
| Single-node K3s | SPOF | Move to managed K8s |
| Single PostgreSQL instance | SPOF for data | Move to managed DB |
| No backups configured | Data loss risk | Set up pg_dump or WAL |

---

## 13. Scalable Architecture Plan

### 13.1 Target Architecture

```mermaid
graph TB
    User["Users"] -->|HTTPS| CF["CloudFront CDN + AWS WAF"]
    CF -->|"Static assets"| S3["Amazon S3<br/>File Storage"]
    CF -->|"API requests"| ALB["AWS ALB<br/>Application Load Balancer"]

    subgraph VPC["AWS VPC (10.0.0.0/16)"]
        subgraph EKS["Amazon EKS Cluster"]
            subgraph FE_HPA["Frontend — HPA: 2-10 replicas"]
                FE1["Frontend Pod"]
                FE2["Frontend Pod"]
                FEn["Frontend Pod"]
            end
            subgraph BE_HPA["Backend — HPA: 2-20 replicas"]
                BE1["Backend Pod"]
                BE2["Backend Pod"]
                BEn["Backend Pod"]
            end
            subgraph AI_HPA["AI Service — HPA: 2-10 replicas"]
                AI1["AI Service Pod"]
                AI2["AI Service Pod"]
                AIn["AI Service Pod"]
            end
        end

        ALB --> FE_HPA
        ALB --> BE_HPA
        BE_HPA --> AI_HPA

        subgraph Data["Data Layer (Private Subnets)"]
            RDS["Amazon RDS PostgreSQL<br/>Multi-AZ + Read Replicas"]
            Redis["ElastiCache Redis<br/>Cluster Mode"]
            SQS["Amazon SQS<br/>Message Queue"]
        end

        BE_HPA --> RDS
        BE_HPA --> Redis
        BE_HPA --> SQS
        AI_HPA --> SQS
        AI_HPA --> Redis
        AI_HPA --> RDS
    end

    AI_HPA -->|HTTPS| OpenAI["OpenAI API"]
    
    Cognito["Amazon Cognito<br/>Auth + JWT"] --> ALB
    SM["AWS Secrets Manager"] --> EKS
    CW["CloudWatch / Datadog<br/>Metrics + Logs + Alerts"] --> EKS
    ACM["AWS Certificate Manager"] --> ALB

    style VPC fill:#f0f4ff,stroke:#3b82f6
    style EKS fill:#e0e7ff,stroke:#6366f1
    style Data fill:#fef3c7,stroke:#f59e0b
```

### 13.2 Component Upgrade Map

| Current | Scalable | Why |
|---------|----------|-----|
| K3s (single node) | **Amazon EKS** (multi-AZ) | HA, auto-scaling, managed control plane |
| Traefik | **AWS ALB** | Layer 7 routing, WAF, health checks |
| External PostgreSQL | **Amazon RDS** (Multi-AZ, read replicas) | Automated backups, failover |
| In-memory cache | **ElastiCache Redis** | Shared state across pods |
| Files in DB TEXT | **Amazon S3** + CloudFront | Unlimited storage, fast downloads |
| `.env` files | **AWS Secrets Manager** | Rotation, IAM access, audit |
| No auth | **Amazon Cognito** | JWT, SSO, user management |
| No CDN | **CloudFront** | Edge caching, DDoS protection |
| No WAF | **AWS WAF** | Injection/XSS protection, rate limiting |
| Console logs | **CloudWatch / Datadog** | Centralized observability |
| No queue | **Amazon SQS** | Decouple AI processing, backpressure |
| Single replicas | **HPA** | Auto-scale on CPU/memory/queue depth |
| No backups | **RDS auto-backups + S3 versioning** | Point-in-time recovery |

### 13.3 Security Layers (Scalable)

```mermaid
graph TB
    subgraph L1["Layer 1: Edge"]
        WAF["CloudFront + AWS WAF<br/>DDoS protection, rate limiting,<br/>SQL injection/XSS rules"]
    end
    subgraph L2["Layer 2: Authentication"]
        Auth["Amazon Cognito<br/>JWT tokens, OAuth 2.0, MFA, SSO"]
    end
    subgraph L3["Layer 3: Authorization"]
        RBAC["RBAC Middleware<br/>User owns sessions, org admin oversight,<br/>row-level security in PostgreSQL"]
    end
    subgraph L4["Layer 4: Secrets"]
        Secrets["AWS Secrets Manager<br/>Auto-rotation, IAM access, CloudTrail audit"]
    end
    subgraph L5["Layer 5: Network"]
        Net["VPC + Security Groups<br/>Private subnets for EKS/RDS/Redis,<br/>public subnets for ALB only"]
    end
    subgraph L6["Layer 6: Data"]
        Enc["Encryption Everywhere<br/>TLS in transit (ACM), AES-256 at rest,<br/>KMS-managed keys"]
    end

    L1 --> L2 --> L3 --> L4 --> L5 --> L6

    style L1 fill:#fee2e2,stroke:#ef4444
    style L2 fill:#fef3c7,stroke:#f59e0b
    style L3 fill:#d1fae5,stroke:#10b981
    style L4 fill:#dbeafe,stroke:#3b82f6
    style L5 fill:#ede9fe,stroke:#8b5cf6
    style L6 fill:#fce7f3,stroke:#ec4899
```

### 13.4 Observability Stack (Scalable)

| Category | Metrics |
|----------|---------|
| **Metrics** | Request latency (p50/p95/p99), error rates, pod CPU/memory, DB connections, Redis hit/miss, OpenAI latency/tokens, SQS depth, active WebSockets |
| **Logs** | Structured JSON, request ID correlation across services, 30-day retention, S3 archive |
| **Traces** | End-to-end request tracing (AWS X-Ray / Datadog APM), service map, bottleneck ID |
| **Alerts** | Error rate >5% (PagerDuty), p99 >30s (Slack), SQS >100 (auto-scale), DB >80% connections (warning) |

### 13.5 Cost Estimate (Scalable)

| Service | Configuration | Monthly Cost |
|---------|--------------|-------------|
| EKS | Control plane + 3x t3.large | ~$250 |
| RDS PostgreSQL | db.r6g.large, Multi-AZ | ~$350 |
| ElastiCache Redis | cache.r6g.large, 2 nodes | ~$300 |
| ALB | 1 ALB + data processing | ~$50 |
| CloudFront | 100GB transfer | ~$20 |
| S3 | 100GB storage | ~$5 |
| Secrets Manager + SQS + Cognito | Various | ~$10 |
| CloudWatch | Logs + metrics | ~$50 |
| **Infrastructure Total** | | **~$1,035/month** |
| **OpenAI API** | Variable (token usage) | **$200-2,000/month** |

---

## 14. System Design Flowcharts — Scalable

### 14.1 Scalable Request Flow

```mermaid
sequenceDiagram
    participant U as User
    participant CF as CloudFront + WAF
    participant ALB as AWS ALB
    participant Cog as Cognito
    participant BE as Backend (EKS)
    participant SQS as Amazon SQS
    participant AI as AI Service (EKS)
    participant Redis as ElastiCache
    participant RDS as Amazon RDS
    participant OAI as OpenAI API
    participant S3 as Amazon S3

    U->>CF: HTTPS request
    CF->>CF: WAF rules (rate limit, injection check)
    
    alt Static asset
        CF->>S3: Fetch from S3 (cached at edge)
        S3-->>CF: Asset
        CF-->>U: Cached response
    else API request
        CF->>ALB: Forward to ALB
        ALB->>Cog: Validate JWT token
        Cog-->>ALB: Token valid
        ALB->>BE: Route to backend pod
        BE->>RDS: Save user message
        BE->>SQS: Enqueue AI job
        BE-->>U: 202 Accepted (WebSocket stays open)
        
        AI->>SQS: Poll message
        AI->>Redis: Load session state (cache hit)
        AI->>OAI: Agent run (gpt-5.2 + tools)
        
        loop Progress
            AI->>Redis: Publish log (Pub/Sub)
            Redis->>BE: Subscribe
            BE-->>U: Socket.IO log stream
        end
        
        OAI-->>AI: Response
        AI->>RDS: Save outputs
        AI->>S3: Upload generated SQL
        AI->>Redis: Update session state
        BE-->>U: Final response via WebSocket
    end
```

### 14.2 Multi-AZ Deployment

```mermaid
graph TB
    R53["Route 53 DNS"] --> CF["CloudFront + WAF"]
    CF --> ALB["ALB (TLS via ACM)"]

    subgraph AZ1["Availability Zone 1a"]
        F1["Frontend Pod"]
        B1["Backend Pod"]
        A1["AI Service Pod"]
        RDS_P["RDS Primary"]
        Red_P["Redis Primary"]
    end

    subgraph AZ2["Availability Zone 1b"]
        F2["Frontend Pod"]
        B2["Backend Pod"]
        A2["AI Service Pod"]
        RDS_S["RDS Standby<br/>(auto-failover)"]
        Red_R["Redis Replica"]
    end

    subgraph AZ3["Availability Zone 1c"]
        F3["Frontend Pod"]
        B3["Backend Pod"]
        A3["AI Service Pod"]
        RDS_R["RDS Read Replica"]
    end

    ALB --> F1 & F2 & F3
    ALB --> B1 & B2 & B3
    B1 & B2 & B3 --> A1 & A2 & A3
    
    RDS_P -->|replication| RDS_S
    RDS_P -->|replication| RDS_R
    Red_P -->|replication| Red_R

    SQS["SQS Queue + DLQ"] --> A1 & A2 & A3

    style AZ1 fill:#dbeafe,stroke:#3b82f6
    style AZ2 fill:#d1fae5,stroke:#10b981
    style AZ3 fill:#fef3c7,stroke:#f59e0b
```

### 14.3 Auto-Scaling Strategy

```mermaid
graph LR
    subgraph HPA["Horizontal Pod Autoscaler"]
        FE["Frontend<br/>Min: 2 | Max: 10<br/>Scale: CPU > 70%"]
        BE["Backend<br/>Min: 2 | Max: 20<br/>Scale: CPU > 60%<br/>or connections > 100"]
        AI["AI Service<br/>Min: 2 | Max: 10<br/>Scale: SQS depth > 5<br/>or CPU > 50%"]
    end

    subgraph Karpenter["Node Auto-Scaling (Karpenter)"]
        Nodes["Min: 3 | Max: 15 nodes<br/>Instance types: t3.large, m6i.xlarge<br/>Scale: pending pod requests"]
    end

    HPA --> Karpenter

    style HPA fill:#ede9fe,stroke:#8b5cf6
    style Karpenter fill:#fce7f3,stroke:#ec4899
```

### 14.4 CI/CD Pipeline

```mermaid
graph LR
    Dev["Developer<br/>git push"] --> GH["GitHub<br/>Webhook"]
    GH --> CI["CI/CD Pipeline"]
    CI --> Test["Run Tests<br/>(unit + integration)"]
    Test --> Build["Build Docker<br/>Images"]
    Build --> ECR["Push to ECR"]
    ECR --> Helm["Helm Upgrade<br/>(rolling deploy)"]
    Helm --> EKS["EKS Cluster"]
    EKS --> HC["Health Check"]
    HC -->|Pass| Done["Deploy Complete"]
    HC -->|Fail| RB["Auto Rollback"]

    style CI fill:#dbeafe,stroke:#3b82f6
    style Done fill:#d1fae5,stroke:#10b981
    style RB fill:#fee2e2,stroke:#ef4444
```

---

## 15. Migration Roadmap: Current to Scalable

### Phase 1: Foundation (Weeks 1-2)
- [ ] AWS account setup with IAM roles
- [ ] VPC with public/private subnets across 3 AZs
- [ ] Provision RDS PostgreSQL (Multi-AZ), migrate data
- [ ] Provision ElastiCache Redis
- [ ] Set up ECR for Docker images

### Phase 2: Compute and Networking (Weeks 3-4)
- [ ] Create EKS cluster with managed node groups
- [ ] ALB Ingress Controller setup
- [ ] ACM certificates for TLS
- [ ] Deploy all services to EKS with HPA
- [ ] Route 53 DNS records

### Phase 3: Security and Auth (Weeks 5-6)
- [ ] Amazon Cognito user pool
- [ ] JWT authentication middleware
- [ ] RBAC implementation
- [ ] Migrate secrets to AWS Secrets Manager
- [ ] Enable RDS encryption, configure WAF

### Phase 4: Storage and Performance (Week 7)
- [ ] Migrate files from DB TEXT to S3
- [ ] CloudFront CDN for frontend + S3
- [ ] Replace in-memory cache with Redis
- [ ] SQS queue for AI job processing
- [ ] Redis Pub/Sub for real-time logs

### Phase 5: Observability and CI/CD (Week 8)
- [ ] CloudWatch / Datadog metrics, logs, traces
- [ ] Alerting (PagerDuty/Slack)
- [ ] GitHub Actions CI/CD pipeline
- [ ] Helm charts for deployments
- [ ] Automated DB backups + S3 lifecycle

### Phase 6: Testing and Launch (Weeks 9-10)
- [ ] Load testing (k6 / Locust)
- [ ] Chaos engineering (pod kills, DB failover)
- [ ] Security audit (penetration testing)
- [ ] Gradual traffic migration (blue-green / canary)
- [ ] Decommission K3s single-node

### Roadmap Timeline

```mermaid
gantt
    title Migration Roadmap: Current to Scalable
    dateFormat  YYYY-MM-DD
    axisFormat  %b %d

    section Phase 1: Foundation
    AWS + VPC + RDS + Redis + ECR     :a1, 2026-04-21, 14d

    section Phase 2: Compute
    EKS + ALB + TLS + Deploy + DNS    :a2, after a1, 14d

    section Phase 3: Security
    Cognito + JWT + RBAC + WAF        :a3, after a2, 14d

    section Phase 4: Performance
    S3 + CDN + Redis + SQS            :a4, after a3, 7d

    section Phase 5: Observability
    Monitoring + CI/CD + Backups      :a5, after a4, 7d

    section Phase 6: Launch
    Load test + Chaos + Migrate       :a6, after a5, 14d
```

---

*Document generated April 14, 2026.*
