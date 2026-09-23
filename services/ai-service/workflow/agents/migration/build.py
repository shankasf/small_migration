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
from typing import Annotated, Any, Literal, TypedDict

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime
from langgraph.types import Command
from pydantic import ValidationError

from config import settings
from validation import rejection_reason, validate_output
from workflow.agents.base import clean_tool_name
from workflow.agents.formatting import files_block
from workflow.agents.migration.schemas import ModelDraft, ModelReview
from workflow.context import TurnContext
from workflow.models import ModelRole
from workflow.prompts import prompt
from workflow.resilience import LLM_RETRY
from workflow.structured import invoke_structured


class ModelReplyError(ValueError):
    """The author did not return one complete model; retry without publishing."""


class BuildState(TypedDict, total=False):
    target: dict[str, Any]
    spec: dict[str, Any]
    previous: str
    attempt: int
    sql: str
    notes: str
    generation_error: str
    feedback: list[str]
    validation: dict[str, Any]
    review: dict[str, Any]
    built: Annotated[list[dict[str, Any]], operator.add]


class BuildOutput(TypedDict):
    built: Annotated[list[dict[str, Any]], operator.add]


def reply_was_truncated(metadata: dict[str, Any]) -> bool:
    """Recognise provider length limits even if the partial SQL happens to parse."""
    return (any(metadata.get(key) in {"length", "max_tokens", "max_output_tokens"}
                for key in ("finish_reason", "stopReason", "stop_reason"))
            or metadata.get("status") == "incomplete")


def parse_draft(reply: AIMessage) -> ModelDraft:
    """Require exactly one complete typed result; never extract SQL from chat text."""
    if reply_was_truncated(reply.response_metadata):
        raise ModelReplyError("The model response was cut off before completion (output limit reached).")
    if reply.invalid_tool_calls:
        raise ModelReplyError("The model returned malformed structured output.")
    if not reply.tool_calls:
        raise ModelReplyError("The model did not return a structured SQL draft.")
    if len(reply.tool_calls) != 1 or clean_tool_name(reply.tool_calls[0]["name"]) != "ModelDraft":
        raise ModelReplyError("The model did not return exactly one SQL draft.")
    try:
        return ModelDraft.model_validate(reply.tool_calls[0]["args"])
    except ValidationError as exc:
        # Pydantic errors can contain the rejected SQL or other input values.
        # Keep those values out of the user-facing error and activity log.
        raise ModelReplyError("The model returned an invalid structured draft. Expected non-empty raw SQL "
                              "in sql and optional short text in notes, with no extra fields.") from exc


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
        # Unforced function calling is supported by the configured Bedrock model;
        # passing tool_choice or relying on provider JSON-schema enforcement is not.
        model = context.models.get(ModelRole.AUTHOR).bind_tools([ModelDraft])
        reply = await model.ainvoke([
            SystemMessage(prompt("author", "dbt_rules", "self_validation")),
            HumanMessage(self.brief(state, context)),
        ])
        try:
            draft = parse_draft(reply)
            sql, notes = draft.sql + "\n", draft.notes
            error = ""
        except ModelReplyError as exc:
            sql, notes, error = "", "", str(exc)
        if context.logger:
            await context.logger.log("model.author", error or "SQL draft received; validation follows.",
                                     log_type="warning" if error else "info",
                                     data={"format": "structured" if reply.tool_calls or reply.invalid_tool_calls else "text",
                                           "attempt": state.get("attempt", 0) + 1})
        return Command(update={"sql": sql, "notes": notes, "generation_error": error,
                               "attempt": state.get("attempt", 0) + 1},
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
        report = {"status": "rejected", "static_checks": "not_run",
                  "errors": [state.get("generation_error") or "The model did not return SQL content."]}
    else:
        report = validate_output(state["target"]["file_name"], state["sql"])
    if report["status"] != "rejected":
        return Command(update={"validation": report}, goto="review")
    reason = (rejection_reason(state["sql"]) if state.get("sql") else "") or report["errors"][0]
    feedback = (f"Generation failed: {reason} Call ModelDraft exactly once with the complete raw SQL in sql "
                "and optional short text in notes. No Markdown fences or extra fields. "
                "Include every required field and CTE; keep comments brief."
                if not state.get("sql") else f"Static validation failed: {reason}")
    return Command(update={"validation": report, "feedback": [feedback]},
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
