"""Capturing a standing instruction, without depending on the model to do it.

The Consultant has `remember`, and uses it most of the time. Most of the time is
not good enough for a promise as plain as "remember this for my future chats":
over repeated live runs GPT-OSS answers warmly and calls nothing, and the user
only finds out weeks later when nothing was remembered.

So the write is a step of its own. When the message plainly asks for something
to be remembered and the turn wrote nothing, this node reads the user's message
— only theirs, never a file or a tool result — and either records one
instruction or decides there was nothing durable in it.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.runtime import Runtime

import guardrails
from config import settings
from utils.realtime_logger import ToolSpan
from workflow.context import TurnContext
from workflow.memory import subject_key, user_namespace
from workflow.models import ModelRole
from workflow.prompts import prompt
from workflow.state import TurnState

# "remember that…", "from now on…", "always prefix…", "for my future chats".
REMEMBER_REQUEST = re.compile(
    r"\bremember\b|\bdon'?t forget\b|\bkeep in mind\b|\bfrom now on\b|\bgoing forward\b"
    r"|\bfor (?:all )?(?:my|our) future (?:chats|conversations|work)\b"
    r"|\b(?:always|never)\b[^.?!]{0,60}\b(?:use|target|name|prefix|suffix|write|build|test|cast)\b",
    re.IGNORECASE)


# Two labelled lines, or NONE. GPT-OSS does not reliably return a schema, and a
# missed structured call here is a promise quietly broken, so the contract is
# one the model cannot half-satisfy and the parse is exact.
CAPTURED = re.compile(r"SUBJECT:\s*(?P<subject>.+?)\s*\n+\s*INSTRUCTION:\s*(?P<instruction>.+)",
                      re.IGNORECASE | re.DOTALL)


def parse_capture(reply: str) -> tuple[str, str]:
    """(subject, instruction), or empty strings when there is nothing durable."""
    text = reply.strip()
    if not text or text.upper().startswith("NONE"):
        return "", ""
    found = CAPTURED.search(text)
    if not found:
        return "", ""
    subject = found.group("subject").strip().strip('"')
    instruction = " ".join(found.group("instruction").split()).strip().strip('"')
    if not subject or not instruction or subject.upper() == "NONE":
        return "", ""
    return subject[:120], instruction


async def capture_memory(state: TurnState, runtime: Runtime[TurnContext]) -> dict[str, Any]:
    """Action step: record what the user asked to be remembered, if the turn did not."""
    context = runtime.context
    store = runtime.store
    workspace = context.workspace
    if store is None or not context.actor_id or workspace.memory_writes:
        return {}
    if not REMEMBER_REQUEST.search(workspace.message):
        return {}
    async with ToolSpan(context.logger, "remember", {"from": "user request"}) as span:
        try:
            reply = await context.models.get(ModelRole.SUMMARIZER).ainvoke([
                SystemMessage(prompt("memory_capture")),
                HumanMessage(workspace.message[:4000]),
            ])
            subject, instruction = parse_capture(reply.text)
        except Exception as error:  # noqa: BLE001 - a turn never fails over memory
            span.result = f"Not saved: {type(error).__name__}"
            return {}
        if not subject:
            span.result = "Nothing durable to save."
            return {}
        text = guardrails.check_outbound(instruction[:settings.MEMORY_FACT_MAX_CHARS]).text
        await store.aput(user_namespace(context.actor_id), subject_key(subject), {
            "text": text, "subject": subject,
            "recorded_at": datetime.now(timezone.utc).isoformat(timespec="seconds")})
        workspace.memory_writes.append(subject)
        span.result = f"Saved '{subject}' for this user's future chats."
    response = state.get("response", "")
    if "remember" in response.lower() or "saved" in response.lower():
        return {}
    # The reply was written before this ran, so say plainly that it was kept.
    return {"response": f"{response}\n\nSaved for your future chats: {text}".strip()}
