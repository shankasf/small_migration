"""Migration subgraph.

    START → analyze (LLM+data) ─questions→ clarify (user input: interrupt)
                               ├─ targets → plan_builds ─Send×N→ build_model → publish (action) → END
                               └─ nothing to build ──────────────────────────→ publish

``clarify`` pauses the thread. The user's next message resumes it, and the turn
re-enters the parent graph at intake so the reply is screened and routed like
any other message; the specification stays in state for the analyst.
"""
from __future__ import annotations

import operator
from typing import Annotated, Any, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime
from langgraph.types import Send, interrupt

import guardrails
from utils.realtime_logger import ToolSpan
from workflow.agents.migration.analyst import RequirementsAnalyst
from workflow.agents.migration.build import build_model_graph
from workflow.context import TurnContext
from workflow.state import MigrationWork, PendingInput, latest


class MigrationState(TypedDict, total=False):
    # Shared with the turn graph.
    migration: Annotated[MigrationWork, latest]
    pending: Annotated[PendingInput | None, latest]
    response: Annotated[str, latest]
    outputs: Annotated[dict[str, str], latest]
    rerun: Annotated[bool, latest]
    # Private to this subgraph.
    built: Annotated[list[dict[str, Any]], operator.add]


def clarify(state: MigrationState) -> dict[str, Any]:
    """User-input step. Nothing runs before ``interrupt``: this node re-runs on resume."""
    interrupt({"kind": "clarification", "message": state["pending"]["question"]})
    return {"rerun": True}


def plan_builds(state: MigrationState) -> dict[str, Any]:
    return {}


def assign_builds(state: MigrationState) -> list[Send]:
    work = state["migration"]
    spec, drafts = work["spec"], work.get("drafts") or {}
    brief = {"requirements": spec["requirements"], "findings": spec["findings"]}
    return [Send("build_model", {"target": target, "spec": brief,
                                 "previous": drafts.get(target.get("revision_of") or target["file_name"], "")})
            for target in spec["targets"]]


async def publish(state: MigrationState, runtime: Runtime[TurnContext]) -> dict[str, Any]:
    """Action step: deliver each passing model as a file and compose the reply."""
    context = runtime.context
    work = dict(state["migration"])
    drafts = dict(work.get("drafts") or {})
    outputs: dict[str, str] = {}
    # Findings describe the analyst's plan, not the outcome of the build. Once
    # models were attempted, only the actual build results can claim success.
    findings = work["spec"]["findings"].strip()
    sections = [findings] if findings and not state.get("built") else []
    for item in sorted(state.get("built") or [], key=lambda built: built["file_name"]):
        name = item["file_name"]
        if guardrails.check_inbound("", {name: ""}).decision == "blocked":
            sections.append(f"### `{name}`\nThis file name was rejected by the data policy, so no file was saved.")
            continue
        if item["validation"].get("status") == "rejected":
            sections.append(f"### `{name}`\nI could not produce a complete, valid model, so no file was saved: "
                            + "; ".join(item["validation"].get("errors", [])))
            continue
        content = guardrails.check_outbound(item["sql"]).text
        async with ToolSpan(context.logger, "generate_output", {"file_name": name, "content": content}) as span:
            outputs[name] = drafts[name] = content
            span.result = f"File '{name}' saved ({len(content)} characters)."
        sections.append(render_model(item, content))
    work["drafts"] = drafts
    return {"outputs": outputs, "migration": work, "pending": None, "response": "\n\n".join(sections)}


def render_model(item: dict[str, Any], content: str) -> str:
    parts = [f"### `{item['file_name']}`", f"```sql\n{content.rstrip()}\n```"]
    if item.get("notes"):
        parts.append(item["notes"])
    for warning in item.get("validation", {}).get("warnings", []):
        parts.append(warning)
    if item["approved"]:
        parts.append("Checked against the 12-point self-validation checklist.")
    elif item["open_issues"]:
        parts.append("**Still open after review — please check:**\n"
                     + "\n".join(f"- {issue}" for issue in item["open_issues"]))
    parts.append(f"Saved as `{item['file_name']}` — see the attached file.")
    return "\n\n".join(parts)


def build_migration_graph():
    builder = StateGraph(MigrationState, context_schema=TurnContext)
    builder.add_node(RequirementsAnalyst.name, RequirementsAnalyst())
    builder.add_node("clarify", clarify)
    builder.add_node("plan_builds", plan_builds)
    builder.add_node("build_model", build_model_graph())
    builder.add_node("publish", publish)
    builder.add_edge(START, RequirementsAnalyst.name)
    builder.add_edge("clarify", END)
    builder.add_conditional_edges("plan_builds", assign_builds, ["build_model"])
    builder.add_edge("build_model", "publish")
    builder.add_edge("publish", END)
    return builder.compile(name="migration")
