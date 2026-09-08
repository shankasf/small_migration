"""
Circini Migration Agent - FastAPI Routes
"""

import os
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Optional, Dict, List, Any
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

from config import settings
from utils.realtime_logger import RealtimeLogger, ToolSpan, preview
import guardrails
from telemetry import (
    get_tracer,
    record_guardrail_decision,
    record_token_usage,
    annotate_genai_span,
)

# Try to import the agents library
try:
    from agents import Agent, Runner, function_tool, ModelSettings, RunConfig, set_tracing_disabled
    set_tracing_disabled(True)
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
    # Identity of the calling turn. The backend is authoritative for both —
    # they are echoed on every activity log line so agent work is attributable
    # to one user id and groupable by turn.
    user_id: Optional[str] = None
    turn_id: Optional[str] = None

class GeneratedFile(BaseModel):
    name: str
    path: str
    content: str
    validation: Dict[str, Any] = {}

class UsageInfo(BaseModel):
    provider: str = "openai"
    model: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0

class GuardrailInfo(BaseModel):
    decision: str = "allow"  # allow | redacted | blocked
    reasons: List[str] = []
    findings: List[Dict[str, Any]] = []
    data_class: str = "metadata"

class ChatResponse(BaseModel):
    response: str
    generated_files: List[GeneratedFile] = []
    usage: Optional[UsageInfo] = None
    guardrail: Optional[GuardrailInfo] = None

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
            # Filenames written by generate_output during the current turn —
            # includes revisions of files first generated in earlier turns.
            "turn_outputs": [],
        }
    return session_storage[session_id]

# Path-component allowlists. `filename` is chosen by the LLM and `session_id`
# arrives in the request body, so neither may be joined onto a path unchecked:
# a traversal ("../") or absolute ("/app/...") value would escape OUTPUT_DIR —
# and pathlib drops the base entirely when the joined part is absolute.
_SAFE_FILENAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SAFE_SESSION_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _safe_join(base: Path, name: str) -> Path:
    """Join `name` onto `base`, refusing anything that escapes `base`."""
    if not _SAFE_FILENAME.match(name) or ".." in name:
        raise ValueError(
            f"Invalid file name '{name}'. Use only letters, digits, dot, dash "
            "and underscore — no directory separators or parent references."
        )
    base_resolved = base.resolve()
    target = (base_resolved / name).resolve()
    if target.parent != base_resolved:
        raise ValueError(f"Invalid file name '{name}': path escapes the output folder.")
    return target


def get_session_output_folder(session_id: str) -> Path:
    """Get output folder for session"""
    if not _SAFE_SESSION_ID.match(session_id):
        raise HTTPException(status_code=400, detail="Invalid session id")
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
    filepath = _safe_join(folder, filename)
    filepath.write_text(content)
    return str(filepath)

def create_tools(session_id: str):
    """Create function tools for the agent"""
    if not AGENTS_AVAILABLE:
        return []

    storage = get_session_storage(session_id)

    def _logger() -> Optional[RealtimeLogger]:
        """The logger for the turn currently running on this session."""
        return storage.get("_logger")

    @function_tool
    async def read_file(file_name: str, content: str) -> str:
        """
        Read and store a file for processing.

        Args:
            file_name: Name of the file being uploaded.
            content: The content of the file.
        """
        async with ToolSpan(_logger(), "read_file", {"file_name": file_name, "content": content}) as span:
            checked = guardrails.screen_payload("", {file_name: content})
            if checked["guardrail"]["decision"] == "blocked":
                return "File rejected by policy"
            content = checked["files"][file_name]
            storage["files"][file_name] = content
            span.result = f"File '{file_name}' loaded ({len(content)} characters)."
            return span.result

    @function_tool
    async def generate_output(file_name: str, content: str) -> str:
        """
        Save a generated output file and deliver it to the user as a
        downloadable file card attached to your reply.

        Call this on EVERY turn where you produce or revise a model — for
        corrections, save the complete corrected file under the same file
        name. Files not saved with this tool never reach the user as
        downloads.

        Args:
            file_name: Name for the output file (e.g. "stg_contracts.sql").
            content: The complete file content — never a fragment or diff.
        """
        async with ToolSpan(_logger(), "generate_output", {"file_name": file_name, "content": content}) as span:
            try:
                from validation import validate_output
                if guardrails.check_inbound("", {file_name: ""}).decision == "blocked":
                    return "Output filename rejected by policy"
                content = guardrails.check_outbound(content).text
                report = validate_output(file_name, content)
                if report["status"] == "rejected":
                    return "Output validation failed: " + "; ".join(report["errors"])
                # The database is the durable artefact store. Avoid a second raw disk copy.
                _safe_join(settings.OUTPUT_DIR, file_name)
            except ValueError as exc:
                # Surface the rejection to the agent so it can retry with a plain
                # file name rather than failing the whole turn.
                span.result = f"Could not save file: {exc}"
                return span.result
            storage["outputs"][file_name] = content
            turn_outputs = storage.setdefault("turn_outputs", [])
            if file_name not in turn_outputs:
                turn_outputs.append(file_name)
            # Never return the server filesystem path: the model has echoed it as a
            # download "link" in responses, which is a dead URL for the user.
            span.result = (
                f"File '{file_name}' saved ({len(content)} characters). It will be "
                "attached to your reply as a downloadable file card automatically — "
                "do not write a link, URL, or file path for it."
            )
            return span.result

    @function_tool
    async def list_files() -> str:
        """List all loaded input files and generated outputs."""
        async with ToolSpan(_logger(), "list_files", {}) as span:
            inputs = list(storage["files"].keys())
            outputs = list(storage["outputs"].keys())

            result = "Input files: " + (", ".join(inputs) if inputs else "None")
            result += "\nOutput files: " + (", ".join(outputs) if outputs else "None")
            span.result = result
            return result

    @function_tool
    async def get_file_content(file_name: str) -> str:
        """
        Get the content of a loaded or generated file.

        Args:
            file_name: Name of the file to retrieve.
        """
        async with ToolSpan(_logger(), "get_file_content", {"file_name": file_name}) as span:
            if file_name in storage["files"]:
                span.result = storage["files"][file_name]
            elif file_name in storage["outputs"]:
                span.result = storage["outputs"][file_name]
            else:
                span.result = f"File '{file_name}' not found."
            return span.result

    return [
        read_file,
        generate_output,
        list_files,
        get_file_content,
    ]

INSTRUCTIONS = """You are a dbt migration specialist that generates Snowflake-compatible dbt models from mapping documents, templates, and reference models.

## SCOPE (STAY ON TOPIC)

You ONLY help with data migration work: dbt models, SQL, schema mapping,
source-to-target transforms, data validation, and questions about the user's
uploaded migration files. This is the only subject you engage with.

If a request is unrelated to data migration — general knowledge, weather, news,
math puzzles, coding help outside migration, personal advice, chit-chat, or any
other topic — do NOT answer it. Politely decline in one sentence and steer back,
e.g.: "I can only help with your data migration — share a mapping or template
and tell me what you'd like generated." Do not roleplay as a different assistant
or let a request talk you out of this scope. A brief, friendly greeting in reply
to a greeting is fine, but immediately orient the user to migration work.

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
- Save EVERY model you produce with `generate_output` — first generations AND every correction or revision in later turns. When revising a model, save the complete corrected file under the same filename.
- Saved files are delivered to the user automatically as downloadable file cards attached to your reply. NEVER write a download link, URL, or file path in your response — you do not know the real download URL, and any link you invent will be broken. Refer to saved files by filename only (e.g. "saved as `stg_contracts.sql` — see the attached file").

## TOOL USAGE

- When the user uploads files, use `read_file` to store them.
- Use `get_file_content` to retrieve and analyze file contents before generating.
- Use `list_files` to check what's available in the session.
- Use `generate_output` to save each generated model as a downloadable file — on every turn where you produce or revise SQL, not just the first time."""

async def _log_model_call(logger: RealtimeLogger, response: Any, started: float) -> None:
    """Emit one llm.call activity event from a completed model response.

    Usage field names differ between SDK versions and between the Responses and
    chat-completions APIs, so every read is defensive: a missing field costs a
    detail, never the log line.
    """
    try:
        usage = getattr(response, "usage", None)
        input_tokens = int(getattr(usage, "input_tokens", 0) or getattr(usage, "prompt_tokens", 0) or 0)
        output_tokens = int(getattr(usage, "output_tokens", 0) or getattr(usage, "completion_tokens", 0) or 0)
        details = getattr(usage, "output_tokens_details", None)
        reasoning_tokens = int(getattr(details, "reasoning_tokens", 0) or 0)
        in_details = getattr(usage, "input_tokens_details", None)
        cached_tokens = int(getattr(in_details, "cached_tokens", 0) or 0)
        await logger.llm_call(
            model=str(getattr(response, "model", settings.model_name)),
            provider=settings.LLM_PROVIDER,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            duration_ms=int((time.monotonic() - started) * 1000),
            reasoning_tokens=reasoning_tokens,
            cached_tokens=cached_tokens,
        )
    except Exception as exc:  # pragma: no cover - telemetry must never break a turn
        print(f"[USAGE] Could not log model call: {exc}")


def get_or_create_agent(session_id: str) -> "Agent":
    """Get cached agent for session, or create a new one"""
    if session_id not in session_agents:
        tools = create_tools(session_id)
        session_agents[session_id] = Agent(
            name="MigrationAgent",
            instructions=INSTRUCTIONS,
            model=settings.model_name,
            tools=tools,
            model_settings=ModelSettings(
                reasoning=Reasoning(effort="low"),
                max_tokens=16000,
                store=False,
            )
        )
    return session_agents[session_id]

import asyncio
_active_sessions: set[str] = set()
_active_users: Dict[str, set] = {}

@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest):
    if request.session_id in _active_sessions:
        raise HTTPException(status_code=409, detail="A request is already running in this session")
    _active_sessions.add(request.session_id)
    task = asyncio.current_task()
    if request.user_id:
        _active_users.setdefault(request.user_id, set()).add(task)
    try:
        return await _chat(request)
    finally:
        _active_sessions.discard(request.session_id)
        if request.user_id:
            tasks = _active_users.get(request.user_id, set())
            tasks.discard(task)
            if not tasks:
                _active_users.pop(request.user_id, None)

async def _chat(request: ChatRequest):
    """Process chat message with the agent"""
    if not _SAFE_SESSION_ID.fullmatch(request.session_id):
        raise HTTPException(status_code=400, detail="Invalid session id")
    storage = get_session_storage(request.session_id)
    logger = RealtimeLogger(request.session_id, turn_id=request.turn_id, user_id=request.user_id)
    # Tools are created once per session and cached with the agent, so they read
    # the current turn's logger off session storage rather than closing over it.
    storage["_logger"] = logger
    turn_started = time.monotonic()

    try:
        # --- Guardrails inbound (§9): sanitise, injection/deny checks, PII
        # detection, then block (Mode A) or redact before any model egress ---
        await logger.thinking("Running guardrail checks...")
        screened = guardrails.screen_payload(request.message, request.files, request.history)
        inbound = guardrails.check_inbound(screened["message"], screened["files"])
        if screened["guardrail"]["decision"] == "blocked":
            inbound.decision = "blocked"
            inbound.reasons = screened["guardrail"]["reasons"]
        elif screened["guardrail"]["decision"] == "redacted":
            inbound.decision = "redacted"
            inbound.reasons = screened["guardrail"]["reasons"]
        inbound.findings = {item["type"]: item["count"] for item in screened["guardrail"]["findings"]}
        inbound.data_class = screened["guardrail"]["data_class"]
        request.history = screened["history"]
        record_guardrail_decision(inbound.decision, stage="inbound")

        if inbound.decision == "blocked":
            await logger.guardrail(
                "inbound", "blocked", inbound.reasons,
                [{"type": k, "count": v} for k, v in inbound.findings.items()],
            )
            return ChatResponse(
                response=guardrails.block_message(inbound.reasons),
                guardrail=GuardrailInfo(**inbound.as_dict()),
                usage=UsageInfo(provider=settings.LLM_PROVIDER, model=settings.model_name),
            )

        if inbound.decision == "redacted":
            await logger.guardrail(
                "inbound", "redacted", inbound.reasons,
                [{"type": k, "count": v} for k, v in inbound.findings.items()],
            )

        # Redacted payload is what reaches storage and the model
        safe_message = inbound.text
        safe_files = getattr(inbound, "redacted_files", request.files or {})

        storage["files"] = {}
        storage["outputs"] = {}
        # Bug 7 fix: Hydrate session storage from request files if storage is empty
        # (handles pod restart — files come from DB via backend)
        if safe_files:
            await logger.thinking("Loading uploaded files...")
            for filename, content in safe_files.items():
                storage["files"][filename] = content

        # Build the current user message (with file upload context if any)
        current_message = safe_message
        if safe_files:
            file_list = ", ".join(safe_files.keys())
            current_message += f"\n\n[Uploaded files: {file_list}]\n"
            for filename, content in safe_files.items():
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

        # Reset the per-turn write log. generate_output records every file it
        # writes this turn here — including revisions of files first generated
        # in earlier turns, which a "new filenames only" filter would drop.
        storage["turn_outputs"] = []

        await logger.thinking("Processing your request...")

        input_tokens = 0
        output_tokens = 0
        tracer = get_tracer()
        span_cm = (
            tracer.start_as_current_span("circini.chat")
            if tracer is not None
            else None
        )
        if span_cm is not None:
            span_cm.__enter__()

        try:
            if AGENTS_AVAILABLE:
                # Bug 3 fix: Reuse cached agent for session continuity
                agent = get_or_create_agent(request.session_id)

                await logger.ai_thinking("AI agent is analyzing...")

                # Pass structured message list to Runner and stream text deltas
                # to the client over the realtime-log channel as they arrive.
                # Chunks are guardrail-filtered before egress; the final,
                # fully-filtered text still replaces the stream at the end.
                try:
                    from openai.types.responses import ResponseTextDeltaEvent
                except ImportError:
                    ResponseTextDeltaEvent = None
                # Each completed model call carries its own usage block. Logging
                # it per call (rather than only the run total) is what makes the
                # activity log answer "which call cost what".
                try:
                    from openai.types.responses import ResponseCompletedEvent
                except ImportError:
                    ResponseCompletedEvent = None

                result = Runner.run_streamed(agent, messages, run_config=RunConfig(tracing_disabled=True, trace_include_sensitive_data=False))
                stream_buffer = ""
                last_flush = time.monotonic()

                async def flush_stream():
                    nonlocal stream_buffer, last_flush
                    if not stream_buffer:
                        return
                    chunk = guardrails.check_outbound(stream_buffer).text
                    stream_buffer = ""
                    last_flush = time.monotonic()
                    await logger.log(step="stream", message=chunk, log_type="delta")

                call_started = time.monotonic()
                async for event in result.stream_events():
                    if (
                        ResponseTextDeltaEvent is not None
                        and event.type == "raw_response_event"
                        and isinstance(event.data, ResponseTextDeltaEvent)
                        and event.data.delta
                    ):
                        stream_buffer += event.data.delta
                        # Buffer the complete response; identifiers can span deltas.
                        if len(stream_buffer) > settings.MAX_INPUT_CHARS:
                            result.cancel()
                            raise ValueError("Model response exceeds output limit")
                    elif (
                        ResponseCompletedEvent is not None
                        and event.type == "raw_response_event"
                        and isinstance(event.data, ResponseCompletedEvent)
                    ):
                        await _log_model_call(logger, event.data.response, call_started)
                        call_started = time.monotonic()
                await flush_stream()
                response_text = result.final_output

                # Token usage for metering/governance (defensive across SDK versions)
                try:
                    usage = result.context_wrapper.usage
                    input_tokens = int(getattr(usage, "input_tokens", 0) or 0)
                    output_tokens = int(getattr(usage, "output_tokens", 0) or 0)
                except Exception as usage_err:
                    print(f"[USAGE] Could not extract token usage: {usage_err}")

                await logger.agent_output(
                    response_text or "",
                    duration_ms=int((time.monotonic() - turn_started) * 1000),
                )
                await logger.complete("Response ready")
            else:
                response_text = f"Received: {safe_message}\nFiles: {list(safe_files.keys()) if safe_files else 'None'}"
        except Exception as e:
            await logger.log(
                step="error",
                message="AI processing failed",
                log_type="error",
                duration_ms=int((time.monotonic() - turn_started) * 1000),
                detail={"error": type(e).__name__},
            )
            raise HTTPException(status_code=500, detail="AI processing failed")
        finally:
            if span_cm is not None:
                try:
                    from opentelemetry import trace as _trace
                    annotate_genai_span(
                        _trace.get_current_span(),
                        model=settings.model_name,
                        provider=settings.LLM_PROVIDER,
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        guardrail_decision=inbound.decision,
                        data_class=inbound.data_class,
                    )
                finally:
                    span_cm.__exit__(None, None, None)

        record_token_usage(settings.model_name, input_tokens, output_tokens)

        # --- Guardrails outbound (§9): content filter on the response and any
        # generated files before returning to the user ---
        outbound = guardrails.check_outbound(response_text or "")
        record_guardrail_decision(outbound.decision, stage="outbound")
        response_text = outbound.text
        if outbound.decision == "redacted":
            await logger.guardrail(
                "outbound", "redacted", outbound.reasons,
                [{"type": k, "count": v} for k, v in outbound.findings.items()],
            )

        # Return every file written this turn — new files and revisions alike
        generated_files = []
        output_folder = storage.get("output_folder")
        for filename in storage.get("turn_outputs", []):
            content = storage["outputs"].get(filename)
            if not content:
                continue
            filepath = str(output_folder / filename) if output_folder else filename
            filtered = guardrails.check_outbound(content)
            generated_files.append(GeneratedFile(
                name=filename,
                path=filepath,
                content=filtered.text,
                validation=__import__("validation").validate_output(filename, filtered.text),
            ))

        # Combined guardrail verdict for audit: blocked > redacted > allow
        decision = "redacted" if (inbound.decision == "redacted" or outbound.decision == "redacted") else "allow"
        combined_findings = dict(inbound.findings)
        for k, v in outbound.findings.items():
            combined_findings[k] = combined_findings.get(k, 0) + v

        return ChatResponse(
            response=response_text,
            generated_files=generated_files,
            usage=UsageInfo(
                provider=settings.LLM_PROVIDER,
                model=settings.model_name,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                total_tokens=input_tokens + output_tokens,
            ),
            guardrail=GuardrailInfo(
                decision=decision,
                reasons=list(dict.fromkeys(inbound.reasons + outbound.reasons)),
                findings=[{"type": k, "count": v} for k, v in combined_findings.items()],
                data_class=inbound.data_class,
            ),
        )
    finally:
        if storage.get("_logger") is logger:
            storage.pop("_logger", None)
        await logger.close()

@router.post("/reset/{session_id}")
async def reset_session(session_id: str):
    """Reset session storage and cached agent"""
    if not _SAFE_SESSION_ID.fullmatch(session_id):
        raise HTTPException(status_code=400, detail="Invalid session id")
    if session_id in _active_sessions:
        raise HTTPException(status_code=409, detail="Session is busy; retry deletion after the turn completes")
    import shutil
    folder = (settings.OUTPUT_DIR / session_id).resolve()
    if folder.parent == settings.OUTPUT_DIR.resolve() and folder.exists():
        shutil.rmtree(folder)
    session_last_access.pop(session_id, None)
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


class PolicyRequest(BaseModel):
    message: str = ""
    files: Optional[Dict[str, str]] = None
    history: Optional[List[Dict[str, str]]] = None


@router.post("/policy/check")
async def policy_check(request: PolicyRequest):
    return guardrails.screen_payload(request.message, request.files, request.history)


@router.get("/security/status")
async def policy_status():
    from llm import security_status
    return security_status()

class FixtureRequest(BaseModel):
    content: str
    fixture: Dict[str, Any]


@router.post('/validation/test')
async def fixture_test(request: FixtureRequest):
    import asyncio
    import json
    import sys
    from validation import validate_output
    encoded_fixture = json.dumps(request.fixture)
    checked = guardrails.screen_payload(request.content, {'fixture.json': encoded_fixture})
    if checked['guardrail']['decision'] != 'allow':
        raise HTTPException(status_code=422, detail='Use synthetic, non-sensitive fixtures only')
    report = validate_output('model.sql', request.content)
    if report['status'] == 'rejected':
        return report
    if len(encoded_fixture) > 200000:
        raise HTTPException(status_code=413, detail='Fixture exceeds size limit')
    process = await asyncio.create_subprocess_exec(
        sys.executable, str(Path(__file__).resolve().parent.parent / 'sandbox_validation.py'),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        env={'PATH': os.defpath},
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(json.dumps(request.model_dump()).encode()), timeout=10)
        report['fixture_test'] = json.loads(output)
    except (asyncio.TimeoutError, ValueError):
        if process.returncode is None:
            process.kill()
        await process.wait()
        report['fixture_test'] = {'status': 'failed', 'reason': 'Validation exceeded execution limits'}
    return report


@router.post('/cancel/user/{user_id}')
async def cancel_user_runs(user_id: str):
    tasks = list(_active_users.get(user_id, set()))
    for task in tasks:
        task.cancel()
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    return {'cancelled': len(tasks)}
