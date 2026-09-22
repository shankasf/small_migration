"""Checkpointed graph state.

Following "Thinking in LangGraph", state stores raw facts, not formatted
prompts: nodes format what they need on demand. Only screened content enters
state, and bulky per-turn inputs (files, history) stay in the runtime context.

Values are plain JSON-like data (``Route.X.value``, never the enum): checkpoints
are deserialised with LangGraph's strict allow-list, which refuses app classes.
Keys a subgraph writes back to the turn graph carry the ``latest`` reducer.
"""
from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Literal, TypedDict


def latest(_current: Any, update: Any) -> Any:
    """Last-write-wins reducer for keys shared with subgraphs."""
    return update


class Route(StrEnum):
    GENERATE = "generate"        # create or revise dbt model files
    CONSULT = "consult"          # migration questions, reviews, explanations
    REPOSITORY = "repository"    # read-only GitHub browsing and explanation
    HISTORY = "history"          # recall earlier chats and files
    IMPACT = "impact"            # dbt impact / lineage analysis
    OUT_OF_SCOPE = "out_of_scope"


class RouteDecision(TypedDict):
    route: str
    new_analysis: bool


class PendingInput(TypedDict):
    """A question the assistant asked and is waiting on (user-input step)."""

    kind: Literal["clarification", "impact_sources"]
    question: str
    route: str


class GuardrailVerdict(TypedDict, total=False):
    decision: str
    reasons: list[str]
    findings: dict[str, int]
    data_class: str


class MigrationWork(TypedDict, total=False):
    spec: dict[str, Any] | None          # last MigrationSpec (raw model dump)
    drafts: dict[str, str]               # file name -> latest generated SQL


class ImpactWork(TypedDict, total=False):
    analysis_id: str
    evidence_reads: int


class TurnState(TypedDict, total=False):
    # Reset at the start of every turn by the intake node.
    turn_id: str
    message: str
    guardrail: GuardrailVerdict
    route: RouteDecision | None
    safety: dict[str, Any] | None         # Injection Guard verdict
    response: Annotated[str, latest]
    outputs: Annotated[dict[str, str], latest]
    impact_action: Annotated[str | None, latest]
    rerun: Annotated[bool, latest]        # a paused step was answered: route the reply afresh
    # Carried across turns in the thread's checkpoint.
    pending: Annotated[PendingInput | None, latest]
    migration: Annotated[MigrationWork, latest]
    impact: Annotated[ImpactWork, latest]


class TurnInput(TypedDict, total=False):
    turn_id: str


class TurnOutput(TypedDict, total=False):
    response: str
    outputs: dict[str, str]
    impact_action: str | None
    guardrail: GuardrailVerdict
    route: RouteDecision | None
