"""Composition root: builds the agent runtime once per process.

The graph is compiled once at startup and shared by every request; per-turn
data arrives through the runtime context.
"""
from __future__ import annotations

from dataclasses import dataclass

from langgraph.store.base import BaseStore

from workflow.checkpointing import create_checkpointer
from workflow.memory import create_store
from workflow.models import ModelRegistry, default_registry
from workflow.orchestrator import build_turn_graph
from workflow.runner import TurnRunner
from workflow.tracing import TraceExporter


@dataclass
class AgentRuntime:
    runner: TurnRunner
    tracer: TraceExporter
    store: BaseStore | None = None


def build_runtime(models: ModelRegistry | None = None) -> AgentRuntime:
    tracer = TraceExporter()
    # Checkpointer: this chat, for 30 days. Store: this user, indefinitely.
    store = create_store()
    graph = build_turn_graph(create_checkpointer(), store=store)
    return AgentRuntime(runner=TurnRunner(graph, models or default_registry(), tracer), tracer=tracer, store=store)
