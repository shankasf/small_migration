"""Turn runner: the single entry point from the HTTP layer into the graph.

A chat session is a LangGraph thread (``thread_id`` = session id). If the thread
is paused on a user-input step, the new message resumes it with
``Command(resume=...)``; otherwise it starts a new run. Either way the request's
content travels in the runtime context, not in the resume value, so nothing
unscreened is ever written to a checkpoint.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from langgraph.types import Command

from config import settings
from utils.realtime_logger import RealtimeLogger
from workflow.context import TurnContext, TurnRequest
from workflow.gateway import BackendGateway, HttpBackendGateway
from workflow.models import ModelRegistry
from workflow.state import TurnInput
from workflow.tracing import TraceExporter
from workflow.usage import UsageMeter


@dataclass
class TurnResult:
    response: str
    files: dict[str, str] = field(default_factory=dict)
    impact_action: Optional[str] = None
    guardrail: dict[str, Any] = field(default_factory=dict)
    route: Optional[str] = None
    paused: bool = False
    input_tokens: int = 0
    output_tokens: int = 0


class TurnRunner:
    def __init__(self, graph, models: ModelRegistry, tracer: TraceExporter, *,
                 gateway_factory: Callable[[str, Optional[str]], BackendGateway] = HttpBackendGateway,
                 max_concurrent_turns: int = settings.MAX_CONCURRENT_TURNS):
        self.graph = graph
        self.models = models
        self.tracer = tracer
        self.gateway_factory = gateway_factory
        self._slots = asyncio.Semaphore(max_concurrent_turns)

    def thread(self, session_id: str) -> dict[str, Any]:
        return {"configurable": {"thread_id": session_id}}

    async def run(self, request: TurnRequest, *, session_id: str, actor_id: Optional[str],
                  turn_id: Optional[str], logger: Optional[RealtimeLogger]) -> TurnResult:
        # Memory scales with turns in flight (each holds its files), so turns queue for a slot.
        async with self._slots:
            return await self._run(request, session_id, actor_id, turn_id, logger)

    async def _run(self, request, session_id, actor_id, turn_id, logger) -> TurnResult:
        context = TurnContext(session_id=session_id, actor_id=actor_id, turn_id=turn_id, request=request,
                              gateway=self.gateway_factory(session_id, actor_id), models=self.models, logger=logger)
        meter = UsageMeter(logger, model=self.models.model_name, provider=self.models.provider_name)
        config = {
            **self.thread(session_id),
            "callbacks": [meter, *self.tracer.callbacks()],
            "max_concurrency": settings.MAX_PARALLEL_TASKS,
            "recursion_limit": 100,
            "run_name": "chat_turn",
            "tags": ["chat-turn"],
            "metadata": {"session_id": session_id, "turn_id": turn_id or ""},
        }
        snapshot = await self.graph.aget_state(config)
        payload = Command(resume={"turn_id": turn_id or ""}) if snapshot.interrupts else TurnInput(turn_id=turn_id or "")
        # One checkpoint write per turn: on exit, pause or failure.
        output = await self.graph.ainvoke(payload, config, context=context, durability="exit", version="v2")
        values = output.value or {}
        route = (values.get("route") or {}).get("route")
        if output.interrupts:
            question = output.interrupts[0].value
            return TurnResult(response=question["message"], guardrail=values.get("guardrail") or {},
                              impact_action=question.get("impact_action", values.get("impact_action")),
                              route=route, paused=True,
                              input_tokens=meter.input_tokens, output_tokens=meter.output_tokens)
        return TurnResult(response=values.get("response") or "", files=values.get("outputs") or {},
                          impact_action=values.get("impact_action"), guardrail=values.get("guardrail") or {},
                          route=route, input_tokens=meter.input_tokens, output_tokens=meter.output_tokens)

    async def forget(self, session_id: str) -> None:
        """Delete every checkpoint of a chat (chat deletion, reset)."""
        checkpointer = self.graph.checkpointer
        if checkpointer is not None:
            await checkpointer.adelete_thread(session_id)

    async def generated_files(self, session_id: str) -> list[str]:
        snapshot = await self.graph.aget_state(self.thread(session_id))
        return sorted(((snapshot.values or {}).get("migration") or {}).get("drafts") or {})
