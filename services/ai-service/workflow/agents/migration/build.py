"""Per-model build loop, one instance per target via ``Send`` (evaluator-optimizer).

    START → author (LLM) → validate (data) ─rejected→ author … ─passed→ review (LLM)
                                                          review ─defects→ author …
                                                                 └ approved → finish

Validation errors and reviewer defects are LLM-recoverable: they go back to the
author as feedback until the revision budget is spent, then the best draft is
published with its open issues stated.
"""
from __future__ import annotations

import operator
import re
from typing import Annotated, Any, Literal, TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime
from langgraph.types import Command

from config import settings
from validation import rejection_reason, validate_output
from workflow.agents.formatting import files_block
from workflow.agents.migration.schemas import ModelReview
from workflow.context import TurnContext
from workflow.models import ModelRole
from workflow.prompts import prompt
from workflow.resilience import LLM_RETRY
from workflow.structured import invoke_structured

SQL_BLOCK = re.compile(r"```(?:sql)?[ \t]*\n(.*?)```", re.IGNORECASE | re.DOTALL)


class BuildState(TypedDict, total=False):
    target: dict[str, Any]
    spec: dict[str, Any]
    previous: str
    attempt: int
    sql: str
    notes: str
    feedback: list[str]
    validation: dict[str, Any]
    review: dict[str, Any]
    built: Annotated[list[dict[str, Any]], operator.add]


class BuildOutput(TypedDict):
    built: Annotated[list[dict[str, Any]], operator.add]


def split_reply(reply: str) -> tuple[str, str]:
    """(sql, notes) from the author's reply: the fenced block, and what follows it."""
    match = SQL_BLOCK.search(reply)
    if not match:
        return "", ""
    notes = (reply[:match.start()] + reply[match.end():]).strip()
    return match.group(1).strip() + "\n", notes


def attempts_left(state: BuildState) -> bool:
    return state.get("attempt", 0) <= settings.MAX_REVISIONS


class ModelAuthor:
    """LLM step: writes one complete model file."""

    async def __call__(self, state: BuildState, runtime: Runtime[TurnContext]) -> Command[Literal["validate"]]:
        context = runtime.context
        target = state["target"]
        if context.logger:
            verb = "Revising" if state.get("attempt") else "Writing"
            await context.logger.thinking(f"{verb} {target['file_name']}...")
        reply = await context.models.get(ModelRole.AUTHOR).ainvoke([
            SystemMessage(prompt("author", "dbt_rules", "self_validation")),
            HumanMessage(self.brief(state, context)),
        ])
        sql, notes = split_reply(reply.text)
        return Command(update={"sql": sql, "notes": notes, "attempt": state.get("attempt", 0) + 1},
                       goto="validate")

    @staticmethod
    def brief(state: BuildState, context: TurnContext) -> str:
        target, spec = state["target"], state["spec"]
        sections = [
            f"## Model to write\nFile: {target['file_name']}\nPurpose: {target['purpose']}"
            + (f"\nRevision of: {target['revision_of']}" if target.get("revision_of") else ""),
            f"## User request\n{context.workspace.message}",
            f"## Requirements (from the analyst)\n{spec.get('requirements', '')}",
            files_block(context.workspace.files),
        ]
        if state.get("previous"):
            sections.append(f"## Previous version of this file — keep every CTE\n```sql\n{state['previous']}```")
        if state.get("feedback"):
            if state.get("sql"):
                sections.append(f"## Your last draft\n```sql\n{state['sql']}```")
            sections.append("## Fix every one of these before anything else\n"
                            + "\n".join(f"- {item}" for item in state["feedback"]))
        return "\n\n".join(sections)


def validate(state: BuildState) -> Command[Literal["author", "review", "finish"]]:
    """Data step: static SQL/dbt checks (sqlglot); never a warehouse run."""
    if not state.get("sql"):
        report = {"status": "rejected", "errors": ["Reply with the complete model in ONE fenced ```sql block."]}
    else:
        report = validate_output(state["target"]["file_name"], state["sql"])
    if report["status"] != "rejected":
        return Command(update={"validation": report}, goto="review")
    reason = (rejection_reason(state["sql"]) if state.get("sql") else "") or report["errors"][0]
    return Command(update={"validation": report, "feedback": [f"Static validation failed: {reason}"]},
                   goto="author" if attempts_left(state) else "finish")


class ModelReviewer:
    """LLM step: checks the draft against the 12-point checklist."""

    async def __call__(self, state: BuildState, runtime: Runtime[TurnContext]) -> Command[Literal["author", "finish"]]:
        context = runtime.context
        if context.logger:
            await context.logger.thinking(f"Reviewing {state['target']['file_name']} against the checklist...")
        review = await invoke_structured(context.models.get(ModelRole.REVIEWER), ModelReview, [
            SystemMessage(prompt("reviewer", "self_validation", "dbt_rules")),
            HumanMessage(self.brief(state, context)),
        ])
        update = {"review": review.model_dump()}
        if review.approved or not review.issues or not attempts_left(state):
            return Command(update=update, goto="finish")
        return Command(update={**update, "feedback": review.issues}, goto="author")

    @staticmethod
    def brief(state: BuildState, context: TurnContext) -> str:
        sections = [
            f"## Model under review: {state['target']['file_name']}\nPurpose: {state['target']['purpose']}",
            f"## Requirements (from the analyst)\n{state['spec'].get('requirements', '')}",
            files_block(context.workspace.files),
        ]
        if state.get("previous"):
            sections.append(f"## Previous version\n```sql\n{state['previous']}```")
        sections.append(f"## Generated model\n```sql\n{state['sql']}```")
        return "\n\n".join(sections)


def finish(state: BuildState) -> dict[str, Any]:
    validation = state.get("validation") or {}
    issues = [] if (state.get("review") or {}).get("approved") else list((state.get("review") or {}).get("issues") or [])
    return {"built": [{
        "file_name": state["target"]["file_name"],
        "sql": state.get("sql", ""),
        "notes": state.get("notes", ""),
        "validation": validation,
        "approved": validation.get("status") != "rejected" and not issues,
        "open_issues": issues,
        "attempts": state.get("attempt", 0),
    }]}


def build_model_graph():
    builder = StateGraph(BuildState, context_schema=TurnContext, output_schema=BuildOutput)
    builder.add_node("author", ModelAuthor(), retry_policy=LLM_RETRY)
    builder.add_node("validate", validate)
    builder.add_node("review", ModelReviewer(), retry_policy=LLM_RETRY)
    builder.add_node("finish", finish)
    builder.add_edge(START, "author")
    builder.add_edge("finish", END)
    return builder.compile(name="model_build")
