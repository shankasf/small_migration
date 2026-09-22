"""Router Agent (LLM step): classifies the turn before any evidence or tools.

Static context: the routing rules (prompts/router.md).
Dynamic context: the screened message, a pending question, the backend's
impact state, recent conversation and what is attached or connected.
Outcome: a route that the dispatcher maps to one specialist.
"""
from __future__ import annotations

import json
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
        return {"route": RouteDecision(route=self.continuity(state, choice.route),
                                       new_analysis=choice.new_analysis if choice.route == Route.IMPACT else False)}

    @staticmethod
    def continuity(state: TurnState, chosen: str) -> str:
        """A reply to the analyst's pending question goes back to generation.

        GPT-OSS sometimes classifies an answer such as "use in_scope_contracts"
        as a general question. While a clarification is pending, "consult" is
        read as the answer; a reply that changes topic (history, repository,
        impact, out of scope) still routes on its own merits.
        """
        pending = state.get("pending")
        if pending and pending["kind"] == "clarification" and chosen == Route.CONSULT:
            return pending["route"]
        return chosen

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
        }
