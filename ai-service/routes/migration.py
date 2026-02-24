"""
Circini Migration Agent - FastAPI Routes
"""

import os
import time
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, List, Any
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

from config import settings
from utils.realtime_logger import RealtimeLogger

# Try to import the agents library
try:
    from agents import Agent, Runner, function_tool, ModelSettings
    from openai.types.shared import Reasoning
    AGENTS_AVAILABLE = True
except ImportError:
    AGENTS_AVAILABLE = False
    print("Warning: agents library not available, using mock mode")

router = APIRouter()

# Models
class ChatRequest(BaseModel):
    session_id: str
    message: str
    files: Optional[Dict[str, str]] = None
    history: Optional[List[Dict[str, str]]] = None

class GeneratedFile(BaseModel):
    name: str
    path: str
    content: str

class ChatResponse(BaseModel):
    response: str
    generated_files: List[GeneratedFile] = []

# Session storage
session_storage: Dict[str, Dict[str, Any]] = {}

# Cached agents per session (Bug 3 fix: reuse agent across messages)
session_agents: Dict[str, "Agent"] = {}

# Track last access time for TTL eviction
session_last_access: Dict[str, float] = {}

SESSION_TTL_SECONDS = 3600  # 1 hour
SESSION_MAX_COUNT = 50

def _evict_stale_sessions():
    """Evict sessions older than TTL or exceeding max count"""
    now = time.time()
    # Remove sessions older than TTL
    expired = [sid for sid, ts in session_last_access.items() if now - ts > SESSION_TTL_SECONDS]
    for sid in expired:
        session_storage.pop(sid, None)
        session_agents.pop(sid, None)
        session_last_access.pop(sid, None)

    # If still over limit, evict oldest
    if len(session_last_access) > SESSION_MAX_COUNT:
        sorted_sessions = sorted(session_last_access.items(), key=lambda x: x[1])
        to_evict = len(session_last_access) - SESSION_MAX_COUNT
        for sid, _ in sorted_sessions[:to_evict]:
            session_storage.pop(sid, None)
            session_agents.pop(sid, None)
            session_last_access.pop(sid, None)

def get_session_storage(session_id: str) -> Dict[str, Any]:
    """Get or create session storage"""
    _evict_stale_sessions()
    session_last_access[session_id] = time.time()
    if session_id not in session_storage:
        session_storage[session_id] = {
            "files": {},
            "outputs": {},
            "output_folder": None,
        }
    return session_storage[session_id]

def get_session_output_folder(session_id: str) -> Path:
    """Get output folder for session"""
    storage = get_session_storage(session_id)
    if storage["output_folder"] is None:
        timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        folder = settings.OUTPUT_DIR / session_id / timestamp
        folder.mkdir(parents=True, exist_ok=True)
        storage["output_folder"] = folder
    return storage["output_folder"]

def save_output_file(session_id: str, filename: str, content: str) -> str:
    """Save file to session's output folder"""
    folder = get_session_output_folder(session_id)
    filepath = folder / filename
    filepath.write_text(content)
    return str(filepath)

def create_tools(session_id: str):
    """Create function tools for the agent"""
    if not AGENTS_AVAILABLE:
        return []

    storage = get_session_storage(session_id)

    @function_tool
    def read_file(file_name: str, content: str) -> str:
        """
        Read and store a file for processing.

        Args:
            file_name: Name of the file being uploaded.
            content: The content of the file.
        """
        storage["files"][file_name] = content
        return f"File '{file_name}' loaded ({len(content)} characters)."

    @function_tool
    def generate_output(file_name: str, content: str) -> str:
        """
        Generate and save an output file.

        Args:
            file_name: Name for the output file.
            content: The content to write to the file.
        """
        saved_path = save_output_file(session_id, file_name, content)
        storage["outputs"][file_name] = content
        return f"File saved to: {saved_path}"

    @function_tool
    def list_files() -> str:
        """List all loaded input files and generated outputs."""
        inputs = list(storage["files"].keys())
        outputs = list(storage["outputs"].keys())

        result = "Input files: " + (", ".join(inputs) if inputs else "None")
        result += "\nOutput files: " + (", ".join(outputs) if outputs else "None")

        if storage["output_folder"]:
            result += f"\nOutput folder: {storage['output_folder']}"

        return result

    @function_tool
    def get_file_content(file_name: str) -> str:
        """
        Get the content of a loaded or generated file.

        Args:
            file_name: Name of the file to retrieve.
        """
        if file_name in storage["files"]:
            return storage["files"][file_name]
        if file_name in storage["outputs"]:
            return storage["outputs"][file_name]
        return f"File '{file_name}' not found."

    return [
        read_file,
        generate_output,
        list_files,
        get_file_content,
    ]

INSTRUCTIONS = """You are a dbt migration specialist that generates Snowflake-compatible dbt models from mapping documents, templates, and reference models.

## HARD RULES (NEVER SKIP)

1. **BEFORE generating any FROM clause**, explicitly confirm the base/dependency model with the user if it is not clearly specified in the mapping. Models like `in_scope_contracts` MUST be named by the user or present in the mapping — never guess.
2. **NEVER drop a CTE between regenerations.** If you generated a CTE in a prior response, it MUST appear in the next version. Compare your output against the previous version before presenting.
3. **NEVER truncate or omit fields.** Every field in the mapping MUST appear in the final SELECT. If there are 50+ fields, output all 50+ — do not abbreviate with "..." or "remaining fields similar".
4. **NEVER assume or fabricate context you don't have.** If anything is unclear, missing, or ambiguous in the uploaded files — STOP and ask the user a specific clarifying question before proceeding. Do NOT guess join logic, source table structure, transformation rules, or field meanings. It is always better to ask one extra question than to generate incorrect SQL.

## WORKFLOW

Follow these steps in order for every request:

1. **Analyze all uploaded files first.** Use `get_file_content` to read the template (field names, types, nullability, validation rules), the mapping document (source-to-target with transforms), and any existing dbt models BEFORE writing any code. Understand the full picture first.

2. **Ask before you assume.** If ANYTHING is unclear, incomplete, or confusing in the uploaded files, you MUST stop and ask the user a specific question. Common cases:
   - A mapping field is marked "awaiting template", "TBD", or left blank
   - Datatypes conflict between the mapping and the template (e.g., mapping says Boolean but template declares VARCHAR)
   - Default values in the mapping contradict or are missing from the template
   - The base model / dependency model (ref) is not specified or is ambiguous in the mapping
   - A transformation rule, join condition, or filter logic is unclear or could be interpreted multiple ways
   - You are unsure what a column name refers to or which source table it comes from
   Frame each question specifically (e.g., "Field X in the mapping says '...' but the template declares '...' — which should I use?"). Never proceed with a guess.

3. **Generate the dbt model** following the code generation rules below.

4. **Run the self-validation checklist** before presenting output.

## DBT CODE GENERATION RULES

### Source Selection
- Always use `{{ ref('...') }}` models when provided (e.g., `in_scope_contracts`). NEVER default to base tables unless explicitly instructed.
- If no ref model is provided in the mapping, ask the user which model to use as the base.

### CTEs
- Include ALL required CTEs. Every source table referenced in JOINs or field mappings must have its own CTE.
- Never drop a CTE between regenerations. When regenerating, list CTEs from the prior version and verify each is present.

### Field Propagation
- Every mapped field MUST appear in the enriched/final CTE SELECT list.
- After generating, self-check: scan the mapping doc fields and verify each one is present in the output SQL.

### Null Handling
- Use `IFNULL(field, default)` to replace nulls with a default value (not `NULLIF`).
- Use `NULLIF` only to convert a specific value TO null (e.g., `NULLIF(field, '')` to turn empty string into null).
- For string fields, apply `TRIM()` and use `IFNULL(TRIM(field), default)` pattern.

### Datatype Alignment
- Match the template's declared datatype exactly.
- If the mapping says Boolean but the transform logic produces text labels, flag the conflict to the user.
- For Boolean fields expected as VARCHAR, output `'YES'`/`'NO'` strings, not `TRUE`/`FALSE` literals.
- **MINUS/EXCEPT comparison gotcha**: When fields are defaulted to `'NO'`/`'FALSE'` as VARCHAR strings, ensure both sides of any MINUS/EXCEPT/diff comparison produce the same type and default. Mismatched defaults (e.g., `FALSE` boolean vs `'NO'` string) cause false-positive diffs.

### Default Values
- Use defaults from the template. If the template says NOT NULL, never output NULL — use the appropriate default (`'NA'`, `'NO'`, `FALSE`, `0`) based on field type.
- If the template doesn't specify defaults but the baseline uses `'NA'`, ask the user which default to use.

### WHERE Clauses
- Include filtering macros (e.g., `src_snwflk_frozen_source`) when referenced in existing models.
- Always filter to current/non-deleted rows.
- Validate that the WHERE clause source matches the correct source macro — do not copy blindly from a different model.

### CASE Expressions
- Include an `ELSE` branch in every CASE statement.
- Match source codes exactly as documented in the mapping.
- Review every CASE for correct null handling — nulls don't match CASE conditions, so use `IFNULL` before the CASE or handle NULL in a WHEN branch.

### Jinja Patterns
- Use `{{ config() }}`, `{{ source() }}`, `{{ ref() }}` consistent with the existing model patterns provided.

## SELF-VALIDATION CHECKLIST

Before presenting output, verify ALL of the following:
1. Every field in the mapping document appears in the final SELECT.
2. FROM/JOIN sources match the provided ref models, not raw base tables.
3. All CTEs referenced in JOINs are defined.
4. Datatypes match template declarations.
5. No `NULLIF` where `IFNULL` was intended.
6. NOT NULL template fields have defaults, not bare NULLs.
7. WHERE clauses for row filtering are present and use correct source macros.
8. Row count sanity: if the mapping references a filter that should limit rows, verify the WHERE clause implements it.
9. Every CASE expression has an ELSE branch and handles NULLs.
10. No CTEs from a prior generation are missing (compare against previous version if this is a regeneration).
11. Default values are consistent for MINUS/EXCEPT comparisons (same type on both sides).

## OUTPUT FORMAT

- Present your analysis first: template findings, mapping review, any flagged issues or questions.
- Then provide the complete SQL model(s) — full model files, not snippets.
- Use `generate_output` to save each model as a downloadable `.sql` file.

## TOOL USAGE

- When the user uploads files, use `read_file` to store them.
- Use `get_file_content` to retrieve and analyze file contents before generating.
- Use `list_files` to check what's available in the session.
- Use `generate_output` to save each generated model as a downloadable file."""

def get_or_create_agent(session_id: str) -> "Agent":
    """Get cached agent for session, or create a new one"""
    if session_id not in session_agents:
        tools = create_tools(session_id)
        session_agents[session_id] = Agent(
            name="MigrationAgent",
            instructions=INSTRUCTIONS,
            model=settings.OPENAI_MODEL,
            tools=tools,
            model_settings=ModelSettings(
                reasoning=Reasoning(effort="low"),
                max_tokens=16000,
                extra_body={"background": True},
            )
        )
    return session_agents[session_id]

@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    """Process chat message with the agent"""
    storage = get_session_storage(request.session_id)
    logger = RealtimeLogger(request.session_id)

    try:
        # Bug 7 fix: Hydrate session storage from request files if storage is empty
        # (handles pod restart — files come from DB via backend)
        if request.files:
            await logger.thinking("Loading uploaded files...")
            for filename, content in request.files.items():
                storage["files"][filename] = content

        # Build the current user message (with file upload context if any)
        current_message = request.message
        if request.files:
            file_list = ", ".join(request.files.keys())
            current_message += f"\n\n[Uploaded files: {file_list}]\n"
            for filename, content in request.files.items():
                current_message += f"\n[{filename}]:\n{content}\n"

        # Bug 2 fix: Build structured message list instead of flat text
        messages: List[Dict[str, str]] = []
        if request.history:
            for msg in request.history:
                messages.append({
                    "role": msg["role"],
                    "content": msg["content"],  # No truncation
                })
        # Append the current user message
        messages.append({"role": "user", "content": current_message})

        # Bug 4 fix: Snapshot output keys before processing to track only new outputs
        existing_output_keys = set(storage["outputs"].keys())

        await logger.thinking("Processing your request...")

        try:
            if AGENTS_AVAILABLE:
                # Bug 3 fix: Reuse cached agent for session continuity
                agent = get_or_create_agent(request.session_id)

                await logger.ai_thinking("AI agent is analyzing...")

                # Pass structured message list to Runner
                result = Runner.run_streamed(agent, messages)
                async for _event in result.stream_events():
                    pass  # Consume all events to drive the run to completion
                response_text = result.final_output

                await logger.complete("Response ready")
            else:
                response_text = f"Received: {request.message}\nFiles: {list(request.files.keys()) if request.files else 'None'}"
        except Exception as e:
            await logger.error(f"AI processing failed: {str(e)}")
            raise HTTPException(status_code=500, detail=str(e))

        # Bug 4 fix: Only return NEW outputs generated this turn
        generated_files = []
        for filename, content in storage["outputs"].items():
            if content and filename not in existing_output_keys:
                output_folder = storage.get("output_folder")
                filepath = str(output_folder / filename) if output_folder else filename
                generated_files.append(GeneratedFile(
                    name=filename,
                    path=filepath,
                    content=content
                ))

        return ChatResponse(
            response=response_text,
            generated_files=generated_files
        )
    finally:
        await logger.close()

@router.post("/reset/{session_id}")
async def reset_session(session_id: str):
    """Reset session storage and cached agent"""
    if session_id in session_storage:
        del session_storage[session_id]
    if session_id in session_agents:
        del session_agents[session_id]
    return {"message": "Session reset"}

@router.get("/status/{session_id}")
async def get_status(session_id: str):
    """Get session status"""
    storage = get_session_storage(session_id)
    return {
        "files_uploaded": list(storage["files"].keys()),
        "outputs_generated": list(storage["outputs"].keys())
    }
