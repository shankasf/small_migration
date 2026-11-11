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


# "send me the file", "i wana download it", "share that csv here". A bare
# "attached" is not a delivery request: "can't you read the attached file?" is
# a question about a file already in this chat, and used to pin such turns to
# the History Agent after one history answer.
HAND_IT_OVER = re.compile(r"\b(?:give|send|share|attach|hand|provide|email)\b[^.?!]{0,40}"
                          r"\b(?:file|csv|xlsx?|sheet|workbook|spreadsheet|crosswalk|mapping|document|"
                          r"attachment|upload|copy|it|that|this|one)\b"
                          r"|\bdownload\b", re.IGNORECASE)
NAMES_A_REPOSITORY = re.compile(r"\bgit ?hub\b|\bgit ?lab\b|\brepo(?:sitory|sitories)?\b|\bbranch\b", re.IGNORECASE)
ERROR_QUESTION = re.compile(r"\b(?:why|which|what|explain|tell me)\b.*\b(?:invalid|error|fail(?:ed|ure)?|rejected)\b", re.IGNORECASE | re.DOTALL)
REQUESTS_EDIT = re.compile(r"\b(?:fix|correct|change|update|revise|rewrite|regenerate|generate|retry|try again|create|write)\b", re.IGNORECASE)
# The turn really is about saved or earlier chats: finding, recalling or
# delivering something from them. "you parsed it before" or "you said earlier"
# is about THIS chat and does not count.
ASKS_FOR_HISTORY = re.compile(
    r"\b(?:find|search|look(?:ing)? (?:up|for)|locate|retrieve|dig up)\b"
    r"|\b(?:earlier|previous|past|old(?:er)?|other|another|saved|last)\s+(?:chats?|conversations?|sessions?|threads?)\b"
    r"|\b(?:last|previous)\s+(?:week|month)\b|\byesterday\b|\bago\b"
    r"|\bfrom (?:the|that|my) (?:chat|conversation)\b|\bchat history\b|\bfile ?names?\b"
    r"|\b(?:which|what) files? (?:did|have) (?:i|we)\b"
    r"|\b(?:give|send|share|email|hand)\s+(?:me|us)\b|\bdownload\b", re.IGNORECASE)
# A complaint or meta question about the assistant or its last output: "are
# you not able to read the file?", "why can't you...", "how did you generate
# the code?", "do you not understand what it says".
ABOUT_THE_ASSISTANT = re.compile(
    # Negated only: "can you tell me which tests fail?" is an ordinary request.
    r"\b(?:can|could|are|did|do|does|is|were|will|would)(?:n'?t\s+you|\s+you\s+not)\b"
    r"|\b(?:cant|didnt|dont|doesnt|isnt|wont|arent)\s+you\b"
    r"|\b(?:are|were) you (?:un)?able\b|\bhow (?:did|come) you\b|\bwhy\b"
    r"|\byou (?:missed|ignored|skipped|left out|forgot|did ?n'?t|do ?n'?t|can'?t|cant|cannot|said|told)\b", re.IGNORECASE)
# The message points at a file already attached to this chat.
NAMES_THE_ATTACHMENT = re.compile(r"\battach(?:ed|ment)\b|\b(?:the|this|that|my) (?:file|document|doc|design|"
                                  r"markdown|spec)\b|\bsection\b|\.md\b", re.IGNORECASE)
# A correction to a generated model stated as fact: "you missed broker_code",
# "the fields are described in the 'Entitlement Data' section".
STATES_A_CORRECTION = re.compile(
    r"\byou (?:missed|ignored|skipped|left out|forgot)\b|\b(?:is|are) missing\b|\bnot populat\w*"
    r"|\b(?:does|do)(?:n'?t| not) populate\b|\bshould (?:be|have|include|come|map|populate|use)\b"
    r"|\b(?:mapping|template|file|document|doc|spec|design|section) (?:says|states|shows|defines|describes|lists)\b"
    r"|\b(?:are|is) (?:described|defined|listed|specified|documented|explained) in\b", re.IGNORECASE)
# Words that make a turn an impact question on its own merits.
NAMES_IMPACT = re.compile(r"\b(?:impact\w*|lineage|downstream|upstream|depend\w*|break\w*|affect\w*|consumers?|"
                          r"exposures?|dashboards?|rename\w*|drop\w*|risk\w*|blast radius|fail\w*|grain|"
                          r"validat\w*|tests?)\b", re.IGNORECASE)
# A reply to the evidence-source question: a source, a number, a yes/no.
ANSWERS_SOURCES = re.compile(
    r"^\s*(?:[1-6](?:\s*(?:,|and|&|\+)\s*[1-6])*|yes|yeah|yep|y|ok(?:ay)?|sure|no|nope|none|all|both|dbt)\s*[.!]?\s*$"
    r"|\b(?:yes|yeah|yep|go ahead|proceed|all (?:of them|sources)|everything|both|none of them"
    r"|uploads?|uploaded|attachments?|earlier chats?|saved (?:file )?versions?|chat history"
    r"|git ?hub|git ?lab|dbt cloud|run artifacts?|snowflake|use|first|second|third|fourth|fifth|sixth)\b"
    r"|(?:^|\s)[1-6](?:\s|,|$)", re.IGNORECASE)
QUESTION_START = re.compile(r"^\s*(?:why|how|what|which|who|where|when|can|could|are|is|do|does|did|will|would|"
                            r"should|have|has|explain)\b", re.IGNORECASE)


def is_question(message: str) -> bool:
    return "?" in message or bool(QUESTION_START.search(message))


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
        # The eval target passes a state without the message; the screened
        # workspace holds the same text.
        turn = {**state, "message": state.get("message") or context.workspace.message}
        return {"route": self.continuity(turn, RouteDecision(
            route=choice.route, new_analysis=choice.new_analysis if choice.route == Route.IMPACT else False),
            attached=bool(context.workspace.files))}

    @staticmethod
    def continuity(state: TurnState, decision: RouteDecision, attached: bool = False) -> RouteDecision:
        """A reply to a pending question goes back to the step that asked it.

        GPT-OSS sometimes classifies an answer such as "use in_scope_contracts"
        as a general question, "use the dbt repository in GitHub" as a
        repository request, or a repository name as a new analysis. While a
        question is pending, those readings are treated as the answer; a reply
        that changes topic (history, generation, out of scope) still routes on
        its own merits. Whether an answer keeps the evidence grant is left to
        the Grant Judge, which sees the confirmed sources and the question.

        Complaints and questions about the assistant's own output ("are you not
        able to read the attached file?") are never a history search or an
        impact analysis, and never an answer to the evidence-source question.
        """
        pending = state.get("pending")
        message = state.get("message", "")
        decision = RouterAgent.not_a_specialist_lookup(state, decision, attached)
        chosen = decision["route"]
        if not pending:
            if (chosen == Route.GENERATE and ERROR_QUESTION.search(message)
                    and not REQUESTS_EDIT.search(message)):
                return RouteDecision(route=Route.CONSULT.value, new_analysis=False)
            # "give me that file" after a chat-file answer is the same request
            # continued, not a repository question; GPT-OSS reads the bare word
            # "file" as GitHub often enough to send the user to the wrong agent.
            if (chosen in (Route.REPOSITORY, Route.CONSULT) and state.get("last_route") == Route.HISTORY
                    and HAND_IT_OVER.search(message) and not NAMES_A_REPOSITORY.search(message)):
                return RouteDecision(route=Route.HISTORY.value, new_analysis=False)
            return decision
        if pending["kind"] == "clarification" and (
                chosen == Route.CONSULT
                # UAT replay: numbered answers to the analyst's questions ("1. put in placeholders
                # ... 5 either its JSONB 6 no") were read as impact and got the evidence-source
                # question instead of a model. Only an explicit impact request leaves the pending
                # clarification; repository readings of an answer go back to it too.
                or (chosen in (Route.IMPACT, Route.REPOSITORY) and not NAMES_IMPACT.search(message)
                    and not NAMES_A_REPOSITORY.search(message))):
            return RouteDecision(route=pending["route"], new_analysis=False)
        if pending["kind"] == "impact_question" and chosen in (Route.CONSULT, Route.REPOSITORY, Route.IMPACT):
            return RouteDecision(route=Route.IMPACT.value, new_analysis=False)
        if pending["kind"] == "impact_sources" and chosen in (Route.CONSULT, Route.REPOSITORY):
            # UAT: once the source question was asked, every later complaint
            # ("how did you generate the code if you can't access the file?")
            # was forced back to it and got the same question again. Only a
            # reply that could be a source selection stays with impact.
            if not RouterAgent.could_answer_sources(message):
                return decision
            return RouteDecision(route=Route.IMPACT.value, new_analysis=decision["new_analysis"])
        return decision

    @staticmethod
    def could_answer_sources(message: str) -> bool:
        """Could this reply be a selection for the evidence-source question?"""
        if NAMES_IMPACT.search(message):
            return True
        if (ABOUT_THE_ASSISTANT.search(message) or STATES_A_CORRECTION.search(message)
                or (is_question(message) and len(message.split()) > 4)):
            # A complaint or a real question ("what's the difference between
            # IFNULL and NULLIF in Snowflake?") is not a selection, but "can you
            # use the uploaded files?" is.
            return bool(re.search(r"\buse\b", message, re.IGNORECASE)) and bool(ANSWERS_SOURCES.search(message))
        return bool(ANSWERS_SOURCES.search(message))

    @staticmethod
    def not_a_specialist_lookup(state: TurnState, decision: RouteDecision, attached: bool) -> RouteDecision:
        """Questions about this chat's file or the last answer are not history or impact.

        UAT: after generating a model from an attached design .md, "I just gave
        you the file which you parsed, so why can't you read it now" went to
        the History Agent (which only searches saved chats and never sees the
        attachment), and "the fields are described in the 'Entitlement Data'
        section, do you not understand what it says" went to impact, which
        asked for evidence sources. Such turns go to the consultant (which
        reads the attachments), or back to generation when they state a
        correction to the model just generated.
        """
        chosen, message, last = decision["route"], state.get("message", ""), state.get("last_route")
        about_us = bool(ABOUT_THE_ASSISTANT.search(message))
        correction = bool(STATES_A_CORRECTION.search(message))
        if chosen == Route.HISTORY:
            # Files are re-sent on every turn of a chat with an upload, so an
            # attachment alone proves nothing: the message must point at it or
            # at the assistant's handling of it.
            if (not attached or ASKS_FOR_HISTORY.search(message)
                    or not (about_us or correction or NAMES_THE_ATTACHMENT.search(message))):
                return decision
            # "the other one" right after a history answer is still that search,
            # unless the user is complaining about the assistant itself.
            if last == Route.HISTORY and not about_us:
                return decision
        elif chosen == Route.IMPACT:
            pending = state.get("pending") or {}
            correction = correction and (last == Route.GENERATE or bool(NAMES_THE_ATTACHMENT.search(message)))
            if (not (about_us or correction) or NAMES_IMPACT.search(message)
                    or last == Route.IMPACT and pending.get("kind") != "impact_sources"
                    or pending.get("kind") == "impact_question"
                    or (pending.get("kind") == "impact_sources" and RouterAgent.could_answer_sources(message))):
                return decision
        else:
            return decision
        if last == Route.GENERATE and correction and not is_question(message):
            return RouteDecision(route=Route.GENERATE.value, new_analysis=False)
        return RouteDecision(route=Route.CONSULT.value, new_analysis=False)

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
