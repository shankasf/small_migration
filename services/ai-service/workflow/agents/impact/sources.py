"""Evidence-source selection: the impact pipeline's user-input step.

The backend owns the grant — it parses the user's reply, persists which sources
were confirmed, and re-checks the grant on every evidence read. This module only
decides whether the grant covers this turn and, when it does not, asks.
"""
from __future__ import annotations

from typing import Any, Literal

from langgraph.graph import END
from langgraph.runtime import Runtime
from langgraph.types import Command, interrupt

from workflow.context import TurnContext
from workflow.state import PendingInput, Route

SOURCES = {
    "uploads": "Uploaded files and references pasted in this analysis",
    "history": "Earlier chats and saved file versions",
    "github": "GitHub repositories",
    "gitlab": "GitLab repositories",
    "dbt": "dbt Cloud run artifacts",
    "snowflake": "Snowflake schema and dependency metadata",
}


SOURCE_QUESTION = "Before I analyze the impact, which evidence sources should I use?"
NOT_A_SELECTION = "I could not find a source selection in that reply, so here is the list once more."
SET_ASIDE = ("That reply did not choose any evidence sources either, so I have set the impact analysis aside "
             "instead of asking the same question again. If you want an impact analysis, ask for it again and "
             "reply to the source list with names or numbers, for example **uploads** or **1 and 3**. Otherwise, "
             "tell me what you would like me to do and I will help with that.")


def recent_source_questions(history: list[dict[str, str]]) -> int:
    """How many of the latest assistant replies, in a row, were the source question."""
    count = 0
    for message in reversed([m for m in history if m.get("role") == "assistant"]):
        if SOURCE_QUESTION not in (message.get("content") or ""):
            break
        count += 1
    return count


def source_question(connections: list[str]) -> str:
    lines = [SOURCE_QUESTION, ""]
    for n, (source, label) in enumerate(SOURCES.items(), 1):
        status = "" if source in ("uploads", "history") else (
            " (connected)" if source in connections else " (connect in Settings → Integrations first)")
        lines.append(f"{n}. **{label}**{status}")
    lines.extend(["", "Reply with source names or numbers, for example **1 and 3**, **GitHub**, or **all sources**. "
                      "I will only use your selection, ask when the repository/run/file version is ambiguous, "
                      "and recommend validation without running builds or changing data."])
    return "\n".join(lines)


def plan_sources(state: dict[str, Any], runtime: Runtime[TurnContext]) -> Command[Literal["ask_sources", "investigate", "__end__"]]:
    """Data step: does the backend's grant cover this turn?

    A reply to a pending source question that selects nothing is not answered
    with the identical menu forever: it gets the menu once more with a note,
    and a second non-answer clears the pending analysis instead of looping.
    """
    context = runtime.context
    grant = context.impact_state
    menu = source_question(context.impact.get("connections") or [])
    awaiting = bool(grant) and grant.get("phase") != "confirmed"
    asked = recent_source_questions(context.workspace.history) if awaiting else 0
    if asked >= 2:
        return Command(update={"impact_action": "clear", "pending": None, "response": SET_ASIDE}, goto=END)
    if asked == 1:
        menu = f"{NOT_A_SELECTION}\n\n{menu}"
    question = PendingInput(kind="impact_sources", route=Route.IMPACT.value, question=menu)
    if state["route"]["new_analysis"] or not grant:
        # A new analysis never inherits an earlier grant.
        return Command(update={"impact_action": "request_sources", "pending": question}, goto="ask_sources")
    if grant.get("phase") != "confirmed":
        # A vague "yes" or an unrelated reply is not a source selection.
        return Command(update={"impact_action": "continue", "pending": question}, goto="ask_sources")
    return Command(update={"impact_action": "continue", "pending": None,
                           "impact": {"analysis_id": grant["id"]}}, goto="investigate")


def ask_sources(state: dict[str, Any]) -> dict[str, Any]:
    """User-input step. Nothing runs before ``interrupt``: this node re-runs on resume."""
    interrupt({"kind": "impact_sources", "message": state["pending"]["question"],
               "impact_action": state["impact_action"]})
    return {"rerun": True}
