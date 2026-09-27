"""Per-model build loop, one instance per target via ``Send`` (evaluator-optimizer).

    START → author (LLM) → validate (data) ─rejected→ author … ─passed→ review (LLM)
                                                          review ─defects→ author …
                                                                 └ approved → finish

Validation errors and reviewer defects are LLM-recoverable: they go back to the
author as feedback until the revision budget is spent, then the best draft is
published with its open issues stated.

GPT-OSS on Bedrock cannot be forced to call a function, so the draft is taken
from whichever form the reply has: the ``ModelDraft`` call, or one SQL code
block (or raw SQL) in the text. Every captured draft still goes through the
same static checks and reviewer. A failed attempt is never resent as it was:
a reply with no usable draft switches the next attempt's capture mode
(function call ↔ fenced text), and a reply cut off at the output limit moves
the remaining attempts to the low-reasoning author profile, since reasoning
tokens share the output cap.
"""
from __future__ import annotations

import json
import operator
import re
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
from workflow.models import PROFILES, ModelRole
from workflow.prompts import prompt
from workflow.resilience import LLM_RETRY
from workflow.structured import invoke_structured
from workflow.usage import stop_reason

CODE_BLOCK = re.compile(r"^[ \t]*(?P<fence>`{3,}|~{3,})[ \t]*(?P<label>[^\n]*)\n(?P<body>.*?)^[ \t]*(?P=fence)[ \t]*$",
                        re.MULTILINE | re.DOTALL)
FENCE_LINE = re.compile(r"^[ \t]*(?:`{3,}|~{3,})", re.MULTILINE)
SQL_LABELS = {"", "sql", "snowflake", "jinja", "jinja2", "dbt", "sql+jinja"}
# Raw SQL: the whole reply is the model, or a short lead-in sentence precedes it.
# WITH must open a CTE, so a sentence such as "With the mapping, ..." is prose.
CTE_START = r"with\s+(?:recursive\s+)?(?:\w+|\"[^\"]+\")\s+as\s*\("
SQL_HEAD = re.compile(rf"(?:select\b|{CTE_START}|\{{\{{|--|/\*|\()", re.IGNORECASE)
SQL_LINE = re.compile(rf"^[ \t]*(?:\{{\{{-?\s*config\b|{CTE_START}|select\b)", re.IGNORECASE | re.MULTILINE)
LEAD_IN_MAX_CHARS = 500
JSON_HEAD = re.compile(r'\{\s*"')  # function arguments written as text, not Jinja's "{{"

# User-facing reasons: fixed text that never carries model output or retry
# instructions, because it is what the user sees if every attempt fails.
TRUNCATED_ERROR = "The model reached its output limit before it finished the SQL."
TRUNCATED_AGAIN_ERROR = ("The model reached its output limit before it finished the SQL, including on a "
                         "shorter retry with less reasoning.")
NO_SQL_ERROR = "The model replied without any SQL for this model."
INVALID_DRAFT_ERROR = ("The model returned an invalid structured draft. Expected non-empty raw SQL "
                       "in sql and optional short text in notes, with no extra fields.")
RETRY_ADVICE = ("Please ask again; if it keeps failing, ask for fewer checks per model (for example, split "
                "them across two models) or attach only the files this model needs.")

# Author-only instructions, written into the next brief and never into the
# validation report. The output format itself comes from the system prompt
# of the next attempt's capture mode.
TRUNCATED_FEEDBACK = ("Your previous reply was cut off at the output limit before the draft was complete, so "
                      "nothing was saved. Reason briefly and return the complete model at once: keep every "
                      "required field and CTE, keep SQL comments to a minimum and notes to one short sentence.")
CAPTURE_INSTRUCTIONS = {
    "tool": ("Call ModelDraft exactly once with the complete raw SQL in sql and optional short text in notes. "
             "No Markdown fences or extra fields."),
    "text": ("Do not call any function this time: reply with the complete model in exactly one ```sql code "
             "block, then at most one short sentence of notes."),
}


class ModelReplyError(ValueError):
    """The author did not return one complete model; retry without publishing."""

    def __init__(self, message: str, *, truncated: bool = False):
        super().__init__(message)
        self.truncated = truncated


class BuildState(TypedDict, total=False):
    target: dict[str, Any]
    spec: dict[str, Any]
    previous: str
    attempt: int
    sql: str
    notes: str
    generation_error: str
    # Retry strategy: how the next attempt asks for the draft, and whether a
    # cut-off reply moved this model to the low-reasoning author profile.
    capture_mode: Literal["tool", "text"]
    truncated: bool
    recovering: bool
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


def capture_draft(reply: AIMessage) -> tuple[ModelDraft, str]:
    """One complete draft from the reply, and where it was found.

    The ``ModelDraft`` call wins; otherwise the text must hold exactly one SQL
    code block or be raw SQL. Never pick one of several blocks or cut SQL out
    of surrounding prose: that can silently publish only part of the model.
    """
    if reply_was_truncated(reply.response_metadata):
        raise ModelReplyError(TRUNCATED_ERROR, truncated=True)
    drafts = [call for call in reply.tool_calls if clean_tool_name(call["name"]) == "ModelDraft"]
    if len(drafts) > 1 or (drafts and len(reply.tool_calls) > 1):
        raise ModelReplyError("The model did not return exactly one SQL draft.")
    if drafts:
        return draft_from_args(drafts[0]["args"]), "tool_call"
    captured = draft_from_text(reply.text)
    if captured:
        return captured
    if reply.invalid_tool_calls:
        raise ModelReplyError("The model returned malformed structured output.")
    if reply.tool_calls:
        raise ModelReplyError("The model did not return exactly one SQL draft.")
    raise ModelReplyError(NO_SQL_ERROR)


def draft_from_args(args: Any) -> ModelDraft:
    try:
        return ModelDraft.model_validate(args)
    except ValidationError as exc:
        # One fenced model inside sql is still one model: unwrap it and re-check.
        sql = args.get("sql") if isinstance(args, dict) else None
        block = CODE_BLOCK.fullmatch(sql.strip()) if isinstance(sql, str) else None
        if block and sql_label(block):
            try:
                return ModelDraft.model_validate({**args, "sql": block.group("body").strip()})
            except ValidationError:
                pass
        # Pydantic errors can contain the rejected SQL or other input values.
        # Keep those values out of the user-facing error and activity log.
        raise ModelReplyError(INVALID_DRAFT_ERROR) from exc


def draft_from_text(text: str) -> tuple[ModelDraft, str] | None:
    """The draft in a prose reply, or None when the reply holds no SQL at all."""
    text = (text or "").replace("\r\n", "\n").strip()
    if not text:
        return None
    blocks = list(CODE_BLOCK.finditer(text))
    if len(blocks) > 1:
        raise ModelReplyError("The model returned several code blocks instead of one complete SQL model.")
    if blocks:
        block = blocks[0]
        notes = (text[:block.start()] + text[block.end():]).strip()
        if FENCE_LINE.search(notes):
            raise ModelReplyError("The model returned an incomplete code block.")
        if block.group("label").strip().lower() == "json":
            return json_draft(block.group("body")), "json_text"
        if not sql_label(block):
            raise ModelReplyError("The model returned a code block in an unexpected format.")
        return text_draft(block.group("body"), notes), "fenced_block"
    if FENCE_LINE.search(text):
        raise ModelReplyError("The model returned an incomplete code block.")
    if JSON_HEAD.match(text):
        return json_draft(text), "json_text"
    if SQL_HEAD.match(text):
        return text_draft(text, ""), "raw_sql"
    start = SQL_LINE.search(text)
    if start and start.start() <= LEAD_IN_MAX_CHARS:
        return text_draft(text[start.start():], text[:start.start()]), "raw_sql"
    return None


def sql_label(block: re.Match) -> bool:
    label = block.group("label").strip().lower()
    return (label.split() or [""])[0] in SQL_LABELS


def text_draft(sql: str, notes: str) -> ModelDraft:
    notes = notes.strip()
    try:
        # Notes beyond the schema limit are dropped rather than failing the SQL.
        return ModelDraft(sql=sql.strip(), notes=notes if len(notes) <= 4000 else "")
    except ValidationError as exc:
        raise ModelReplyError(NO_SQL_ERROR) from exc


def json_draft(text: str) -> ModelDraft:
    """GPT-OSS sometimes writes the function arguments as text instead of calling it."""
    try:
        args = json.loads(text)
    except ValueError as exc:
        raise ModelReplyError("The model returned malformed structured output.") from exc
    if not isinstance(args, dict) or "sql" not in args:
        raise ModelReplyError(NO_SQL_ERROR)
    return draft_from_args(args)


def attempts_left(state: BuildState) -> bool:
    return state.get("attempt", 0) <= settings.MAX_REVISIONS


class ModelAuthor:
    """LLM step: writes one complete model file."""

    async def __call__(self, state: BuildState, runtime: Runtime[TurnContext]) -> Command[Literal["validate"]]:
        context = runtime.context
        target = state["target"]
        mode = state.get("capture_mode") or "tool"
        # Once a reply has been cut off, every later attempt for this model
        # (reviewer revisions included) keeps the low-reasoning profile.
        recovering = bool(state.get("recovering"))
        role = ModelRole.AUTHOR_RECOVERY if recovering else ModelRole.AUTHOR
        if context.logger:
            verb = "Revising" if state.get("attempt") else "Writing"
            await context.logger.thinking(f"{verb} {target['file_name']}...")
        # Unforced function calling is supported by the configured Bedrock model;
        # passing tool_choice or relying on provider JSON-schema enforcement is not.
        model = context.models.get(role)
        if mode == "tool":
            model = model.bind_tools([ModelDraft])
        reply = await model.ainvoke([
            SystemMessage(prompt("author", "dbt_rules", "self_validation", f"author_output_{mode}")),
            HumanMessage(self.brief(state, context)),
        ])
        source, truncated = "", False
        try:
            draft, source = capture_draft(reply)
            sql, notes = draft.sql + "\n", draft.notes
            error = ""
        except ModelReplyError as exc:
            sql, notes, error, truncated = "", "", str(exc), exc.truncated
            if truncated and recovering:
                error = TRUNCATED_AGAIN_ERROR
        # A reply with no usable draft is not asked for the same way twice.
        next_mode = mode if not error or truncated else ("text" if mode == "tool" else "tool")
        if context.logger:
            # Token counts stay on the llm.call row only; repeating them here
            # would double count them in the activity log.
            await context.logger.log("model.author", error or "SQL draft received; validation follows.",
                                     log_type="warning" if error else "info",
                                     data={"attempt": state.get("attempt", 0) + 1, "captureMode": mode,
                                           "toolCalls": len(reply.tool_calls) + len(reply.invalid_tool_calls),
                                           "capturedFrom": source, "failure": error,
                                           "stopReason": stop_reason(reply.response_metadata),
                                           "truncated": truncated,
                                           "reasoningEffort": PROFILES[role].reasoning_effort,
                                           "replyChars": len(reply.text or "")})
        return Command(update={"sql": sql, "notes": notes, "generation_error": error, "truncated": truncated,
                               "recovering": recovering or truncated, "capture_mode": next_mode,
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
                  "errors": [state.get("generation_error") or NO_SQL_ERROR]}
    else:
        report = validate_output(state["target"]["file_name"], state["sql"])
    if report["status"] != "rejected":
        return Command(update={"validation": report}, goto="review")
    retry = attempts_left(state)
    reason = (rejection_reason(state["sql"]) if state.get("sql") else "") or report["errors"][0]
    if state.get("sql"):
        feedback = f"Static validation failed: {reason}"
    elif state.get("truncated"):
        feedback = TRUNCATED_FEEDBACK
    else:
        feedback = (f"Your previous reply could not be used: {reason} "
                    f"{CAPTURE_INSTRUCTIONS[state.get('capture_mode') or 'tool']} "
                    "Include every required field and CTE; keep comments brief.")
    if not retry and not state.get("sql"):
        report["errors"] = [f"{report['errors'][0]} I tried {state.get('attempt', 0)} times. {RETRY_ADVICE}"]
    return Command(update={"validation": report, "feedback": [feedback]}, goto="author" if retry else "finish")


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
