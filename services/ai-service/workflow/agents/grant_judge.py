"""Grant Judge (LLM step): does this turn continue the confirmed analysis?

GPT-OSS was observed reusing a confirmed evidence grant for a different target
about half the time when routing decided it together with the route. This agent
asks the single question in isolation and fails closed: only an explicit "same
analysis" keeps the grant.
"""
from __future__ import annotations

import json
import re
from typing import Literal

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.runtime import Runtime
from langgraph.types import Command
from pydantic import BaseModel

from workflow.agents.formatting import history_excerpt
from workflow.context import TurnContext
from workflow.models import ModelRole
from workflow.prompts import prompt
from workflow.state import TurnState
from workflow.structured import invoke_structured


# Naming a source category the user has not confirmed is never a continuation.
SOURCE_MENTIONS = {
    "github": re.compile(r"\bgit ?hub\b", re.I),
    "gitlab": re.compile(r"\bgit ?lab\b", re.I),
    "dbt": re.compile(r"\bdbt cloud\b|\bdbt (?:run|job)s?\b|\brun artifacts?\b", re.I),
    "snowflake": re.compile(r"\bsnowflake\b", re.I),
    "uploads": re.compile(r"\buploads?\b|\buploaded (?:files?|references?)\b", re.I),
}


def unconfirmed_sources(message: str, confirmed: list[str]) -> set[str]:
    return {source for source, pattern in SOURCE_MENTIONS.items()
            if source not in confirmed and pattern.search(message)}


class AnalysisContinuity(BaseModel):
    continues_confirmed_analysis: bool


class GrantJudgeAgent:
    name = "grant_judge"

    async def __call__(self, state: TurnState, runtime: Runtime[TurnContext]) -> Command[Literal["dispatch"]]:
        context = runtime.context
        if unconfirmed_sources(context.workspace.message, context.impact_state.get("sources", [])):
            return Command(update={"route": {**state["route"], "new_analysis": True}}, goto="dispatch")
        pending = state.get("pending") if (state.get("pending") or {}).get("route") == "impact" else None
        verdict = await invoke_structured(context.models.get(ModelRole.GRANT_JUDGE), AnalysisContinuity, [
            SystemMessage(prompt("grant_judge")),
            HumanMessage(json.dumps({
                "confirmed_analysis_request": (context.impact_state.get("request") or "")[:3000],
                "confirmed_sources": context.impact_state.get("sources", []),
                "pending_question": pending["question"][:2000] if pending else None,
                "new_message": context.workspace.message,
                "recent_conversation": history_excerpt(context.workspace.history, turns=4),
            }, ensure_ascii=False)),
        ])
        route = {**state["route"], "new_analysis": not verdict.continues_confirmed_analysis}
        return Command(update={"route": route}, goto="dispatch")
