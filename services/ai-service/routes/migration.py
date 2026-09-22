"""
Circini Migration Agent - FastAPI Routes

The HTTP contract with the backend is unchanged; each chat turn is one run of
the LangGraph turn graph (``workflow.orchestrator``) via ``TurnRunner``.
"""

import asyncio
import os
import shutil
import sys
import json
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import guardrails
from config import settings
from output_files import SAFE_SESSION_ID
from telemetry import annotate_genai_span, get_tracer, record_guardrail_decision, record_token_usage
from utils.realtime_logger import RealtimeLogger
from validation import validate_output
from workflow.assembly import AgentRuntime
from workflow.memory import user_namespace
from workflow.context import TurnRequest
from workflow.security import harden_reply

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
    # Backend-owned connection metadata for the authenticated actor, never provider secrets.
    github_context: Optional[Dict[str, Any]] = None
    impact_context: Optional[Dict[str, Any]] = None


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
    impact_action: Optional[str] = None


# --- runtime --------------------------------------------------------------

_runtime: Optional[AgentRuntime] = None


def install_runtime(runtime: Optional[AgentRuntime]) -> None:
    global _runtime
    _runtime = runtime


def agent_runtime() -> AgentRuntime:
    if _runtime is None:
        raise HTTPException(status_code=503, detail="AI runtime is not ready")
    return _runtime


def guardrail_info(verdict: Dict[str, Any]) -> GuardrailInfo:
    return GuardrailInfo(
        decision=verdict.get("decision", "allow"),
        reasons=list(verdict.get("reasons") or []),
        findings=[{"type": k, "count": v} for k, v in (verdict.get("findings") or {}).items()],
        data_class=verdict.get("data_class", "metadata"),
    )


def failure_record(error: BaseException, session_id: str) -> Dict[str, Any]:
    """A content-free failure record for the service log.

    Exception messages can quote prompts or model output, so only the type,
    a provider error code and code locations (file:line, no locals) are kept.
    """
    import traceback
    code = getattr(error, "response", None)
    code = code.get("Error", {}).get("Code") if isinstance(code, dict) else None
    frames = [f"{Path(frame.filename).name}:{frame.lineno}:{frame.name}"
              for frame in traceback.extract_tb(error.__traceback__)[-8:]]
    return {"event": "turn.failed", "session_id": session_id, "error": type(error).__name__,
            "provider_code": code, "frames": frames}


# --- chat -----------------------------------------------------------------

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


async def _chat(request: ChatRequest) -> ChatResponse:
    if not SAFE_SESSION_ID.fullmatch(request.session_id):
        raise HTTPException(status_code=400, detail="Invalid session id")
    runtime = agent_runtime()
    models = runtime.runner.models
    logger = RealtimeLogger(request.session_id, turn_id=request.turn_id, user_id=request.user_id)
    started = time.monotonic()
    tracer = get_tracer()
    span_cm = tracer.start_as_current_span("circini.chat") if tracer is not None else None
    if span_cm is not None:
        span_cm.__enter__()
    result = None
    try:
        try:
            result = await runtime.runner.run(
                TurnRequest(message=request.message, files=request.files or {}, history=request.history or [],
                            github_context=request.github_context, impact_context=request.impact_context or {}),
                session_id=request.session_id, actor_id=request.user_id, turn_id=request.turn_id, logger=logger)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            print(json.dumps(failure_record(error, request.session_id)), flush=True)
            await logger.log(step="error", message="AI processing failed", log_type="error",
                             duration_ms=int((time.monotonic() - started) * 1000),
                             detail={"error": type(error).__name__})
            raise HTTPException(status_code=500, detail="AI processing failed")
        finally:
            if span_cm is not None:
                try:
                    from opentelemetry import trace as _trace
                    verdict = result.guardrail if result else {}
                    annotate_genai_span(
                        _trace.get_current_span(), model=models.model_name, provider=models.provider_name,
                        input_tokens=result.input_tokens if result else 0,
                        output_tokens=result.output_tokens if result else 0,
                        guardrail_decision=verdict.get("decision", "allow"),
                        data_class=verdict.get("data_class", "metadata"))
                finally:
                    span_cm.__exit__(None, None, None)

        verdict = dict(result.guardrail)
        if verdict.get("decision") == "blocked":
            return ChatResponse(response=result.response, guardrail=guardrail_info(verdict),
                                usage=UsageInfo(provider=models.provider_name, model=models.model_name))

        record_token_usage(models.model_name, result.input_tokens, result.output_tokens)
        # The graph filters completed replies; a paused question is model text too,
        # so the final reply always crosses the outbound filter here as well.
        outbound = guardrails.check_outbound(result.response)
        hardened = harden_reply(outbound.text)
        if hardened.reasons:
            outbound.decision, outbound.text = "redacted", hardened.text
            outbound.reasons = [*outbound.reasons, *hardened.reasons]
        if outbound.decision == "redacted":
            record_guardrail_decision(outbound.decision, stage="outbound")
            await logger.guardrail("outbound", "redacted", outbound.reasons,
                                   [{"type": k, "count": v} for k, v in outbound.findings.items()])
            verdict["decision"] = "redacted"
            verdict["reasons"] = list(dict.fromkeys([*(verdict.get("reasons") or []), *outbound.reasons]))
        response_text = outbound.text

        await logger.log(step="stream", message=response_text, log_type="delta")
        await logger.agent_output(response_text, duration_ms=int((time.monotonic() - started) * 1000))
        await logger.complete("Response ready")

        files = []
        for name, content in sorted(result.files.items()):
            filtered = guardrails.check_outbound(content).text
            files.append(GeneratedFile(name=name, path=name, content=filtered,
                                       validation=validate_output(name, filtered)))
        return ChatResponse(
            response=response_text,
            impact_action=result.impact_action,
            generated_files=files,
            usage=UsageInfo(provider=models.provider_name, model=models.model_name,
                            input_tokens=result.input_tokens, output_tokens=result.output_tokens,
                            total_tokens=result.input_tokens + result.output_tokens),
            guardrail=guardrail_info(verdict),
        )
    finally:
        await logger.close()


@router.get("/memory/{user_id}")
async def list_memory(user_id: str):
    """The standing instructions held for one user: what they can see and delete."""
    if not SAFE_SESSION_ID.fullmatch(user_id):
        raise HTTPException(status_code=400, detail="Invalid user id")
    store = agent_runtime().store
    if store is None:
        return {"memories": []}
    items = await store.asearch(user_namespace(user_id), limit=100)
    return {"memories": [{"subject": item.value.get("subject", ""), "text": item.value.get("text", ""),
                          "recorded_at": item.value.get("recorded_at", "")} for item in items]}


@router.delete("/memory/{user_id}")
async def forget_user(user_id: str):
    """Erase everything remembered for a user (account deletion, or their request)."""
    if not SAFE_SESSION_ID.fullmatch(user_id):
        raise HTTPException(status_code=400, detail="Invalid user id")
    store = agent_runtime().store
    if store is None:
        return {"forgotten": 0}
    namespace = user_namespace(user_id)
    forgotten = 0
    while True:
        items = await store.asearch(namespace, limit=100)
        if not items:
            break
        for item in items:
            await store.adelete(namespace, item.key)
            forgotten += 1
    return {"forgotten": forgotten}


@router.post("/reset/{session_id}")
async def reset_session(session_id: str):
    """Forget a chat: its checkpoints and any legacy output folder."""
    if not SAFE_SESSION_ID.fullmatch(session_id):
        raise HTTPException(status_code=400, detail="Invalid session id")
    if session_id in _active_sessions:
        raise HTTPException(status_code=409, detail="Session is busy; retry deletion after the turn completes")
    folder = (settings.OUTPUT_DIR / session_id).resolve()
    if folder.parent == settings.OUTPUT_DIR.resolve() and folder.exists():
        shutil.rmtree(folder)
    await agent_runtime().runner.forget(session_id)
    return {"message": "Session reset"}


@router.get("/status/{session_id}")
async def get_status(session_id: str):
    if not SAFE_SESSION_ID.fullmatch(session_id):
        raise HTTPException(status_code=400, detail="Invalid session id")
    return {"files_uploaded": [], "outputs_generated": await agent_runtime().runner.generated_files(session_id)}


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
