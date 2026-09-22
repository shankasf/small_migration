"""The turn graph: one run per chat turn, one thread per chat session.

    START → screen_input ─┬→ route_intent ────┬→ policy_gate ─→ [grant_judge] → dispatch → <specialist> → screen_output → END
                 │        └→ injection_guard ─┘      │ flagged → END                          │
                 │ blocked → END                                                            │
                 └──────────────────── ← rerun (a paused question was answered) ───────────┘

Specialists are registered against a route, so adding one never touches the
orchestration (the registry is the only thing that knows the mapping).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph

from workflow.agents.conversational import ConsultantAgent, HistoryAgent, RepositoryAgent
from workflow.agents.grant_judge import GrantJudgeAgent
from workflow.agents.injection_guard import InjectionGuard
from workflow.agents.impact.graph import build_impact_graph
from workflow.agents.migration.graph import build_migration_graph
from workflow.agents.router import RouterAgent
from workflow.context import TurnContext
from workflow.nodes import (INTAKE, OUTPUT, Dispatcher, after_specialist, policy_gate, scope_guard, screen_input,
                            screen_output)
from workflow.resilience import LLM_RETRY
from workflow.state import Route, TurnInput, TurnOutput, TurnState


@dataclass
class SpecialistRegistry:
    entries: dict[str, tuple[str, Any]] = field(default_factory=dict)

    def register(self, route: Route, node_name: str, node: Any) -> "SpecialistRegistry":
        self.entries[route] = (node_name, node)
        return self

    def path_map(self) -> dict[str, str]:
        return {route: name for route, (name, _) in self.entries.items()}


def default_specialists() -> SpecialistRegistry:
    return (SpecialistRegistry()
            .register(Route.GENERATE, "generate", build_migration_graph())
            .register(Route.CONSULT, "consult", ConsultantAgent())
            .register(Route.REPOSITORY, "repository", RepositoryAgent())
            .register(Route.HISTORY, "history", HistoryAgent())
            .register(Route.IMPACT, "impact", build_impact_graph())
            .register(Route.OUT_OF_SCOPE, "scope_guard", scope_guard))


def build_turn_graph(checkpointer: BaseCheckpointSaver | None, specialists: SpecialistRegistry | None = None):
    specialists = specialists or default_specialists()
    missing = set(Route) - set(specialists.entries)
    if missing:
        raise ValueError(f"No specialist registered for: {', '.join(sorted(missing))}")

    builder = StateGraph(TurnState, context_schema=TurnContext, input_schema=TurnInput, output_schema=TurnOutput)
    builder.add_node(INTAKE, screen_input)
    builder.add_node(RouterAgent.name, RouterAgent(), retry_policy=LLM_RETRY)
    builder.add_node(InjectionGuard.name, InjectionGuard(), retry_policy=LLM_RETRY)
    builder.add_node("policy_gate", policy_gate)
    builder.add_node(GrantJudgeAgent.name, GrantJudgeAgent(), retry_policy=LLM_RETRY)
    builder.add_node(Dispatcher.name, Dispatcher())
    builder.add_node(OUTPUT, screen_output)

    builder.add_edge(START, INTAKE)
    builder.add_edge([RouterAgent.name, InjectionGuard.name], "policy_gate")
    builder.add_conditional_edges(Dispatcher.name, Dispatcher.select, specialists.path_map())
    for name, node in specialists.entries.values():
        builder.add_node(name, node)
        builder.add_conditional_edges(name, after_specialist, [INTAKE, OUTPUT])
    builder.add_edge(OUTPUT, END)
    return builder.compile(checkpointer=checkpointer, name="migration_assistant")
