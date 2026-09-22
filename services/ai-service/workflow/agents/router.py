"""Router Agent (LLM step): classifies the turn before any evidence or tools.

Static context: the routing rules (prompts/router.md).
Dynamic context: the screened message, a pending question, the backend's
impact state, recent conversation and what is attached or connected.
Outcome: a route that the dispatcher maps to one specialist.
"""
from __future__ import annotations

import json
import re
from typing import Literal

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.runtime import Runtime
from pydantic import BaseModel

from workflow.agents.formatting import history_excerpt
from workflow.context import TurnContext
from workflow.models import ModelRole
from workflow.prompts import prompt
from workflow.state import Route, RouteDecision, TurnState
from workflow.structured import invoke_structured


# "send me the file", "i wana download it", "share that csv here".
HAND_IT_OVER = re.compile(r"\b(?:give|send|share|attach|hand|provide|email)\b[^.?!]{0,40}"
                          r"\b(?:file|csv|xlsx?|sheet|workbook|spreadsheet|crosswalk|mapping|document|"
                          r"attachment|upload|copy|it|that|this|one)\b"
                          r"|\bdownload\b|\battach(?:ment|ed)?\b", re.IGNORECASE)
NAMES_A_REPOSITORY = re.compile(r"\bgit ?hub\b|\bgit ?lab\b|\brepo(?:sitory|sitories)?\b|\bbranch\b", re.IGNORECASE)


class RouteChoice(BaseModel):
    route: Literal["generate", "consult", "repository", "history", "impact", "out_of_scope"]
    new_analysis: bool


class RouterAgent:
    name = "route_intent"

    async def __call__(self, state: TurnState, runtime: Runtime[TurnContext]) -> dict:
        context = runtime.context
        if context.impact.get("just_confirmed"):
            # The backend parsed an explicit source list for the pending analysis;
            # there is nothing left to classify.
            return {"route": RouteDecision(route=Route.IMPACT.value, new_analysis=False)}

        if context.logger:
            await context.logger.thinking("Working out what you need...")
        choice = await invoke_structured(context.models.get(ModelRole.ROUTER), RouteChoice, [
            SystemMessage(prompt("router")),
            HumanMessage(json.dumps(self.brief(state, context), ensure_ascii=False)),
        ])
        return {"route": self.continuity(state, RouteDecision(
            route=choice.route, new_analysis=choice.new_analysis if choice.route == Route.IMPACT else False))}

    @staticmethod
    def continuity(state: TurnState, decision: RouteDecision) -> RouteDecision:
        """A reply to a pending question goes back to the step that asked it.

        GPT-OSS sometimes classifies an answer such as "use in_scope_contracts"
        as a general question, "use the dbt repository in GitHub" as a
        repository request, or a repository name as a new analysis. While a
        question is pending, those readings are treated as the answer; a reply
        that changes topic (history, generation, out of scope) still routes on
        its own merits. Whether an answer keeps the evidence grant is left to
        the Grant Judge, which sees the confirmed sources and the question.
        """
        pending, chosen = state.get("pending"), decision["route"]
        if not pending:
            # "give me that file" after a chat-file answer is the same request
            # continued, not a repository question; GPT-OSS reads the bare word
            # "file" as GitHub often enough to send the user to the wrong agent.
            if (chosen in (Route.REPOSITORY, Route.CONSULT) and state.get("last_route") == Route.HISTORY
                    and HAND_IT_OVER.search(state.get("message", ""))
                    and not NAMES_A_REPOSITORY.search(state.get("message", ""))):
                return RouteDecision(route=Route.HISTORY.value, new_analysis=False)
            return decision
        if pending["kind"] == "clarification" and chosen == Route.CONSULT:
            return RouteDecision(route=pending["route"], new_analysis=False)
        if pending["kind"] == "impact_question" and chosen in (Route.CONSULT, Route.REPOSITORY, Route.IMPACT):
            return RouteDecision(route=Route.IMPACT.value, new_analysis=False)
        if pending["kind"] == "impact_sources" and chosen in (Route.CONSULT, Route.REPOSITORY):
            return RouteDecision(route=Route.IMPACT.value, new_analysis=decision["new_analysis"])
        return decision

    @staticmethod
    def brief(state: TurnState, context: TurnContext) -> dict:
        workspace = context.workspace
        pending = state.get("pending")
        return {
            "message": workspace.message,
            "pending_question": {"kind": pending["kind"], "question": pending["question"][:2000]} if pending else None,
            "impact_state": context.impact_state or None,
            "attached_files": list(workspace.files),
            "github_connected": bool(workspace.github_hint),
            "recent_conversation": history_excerpt(workspace.history, turns=6),
            "earlier_conversation_summary": workspace.summary or None,
        }
