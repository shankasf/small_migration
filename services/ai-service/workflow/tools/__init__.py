"""Tools (data steps) the agents may call.

Tools receive the turn through ``ToolRuntime``; LangGraph's ``ToolNode``
injects it and keeps it out of the schema the model sees. The annotation is
``ToolRuntime[Any]`` because LangChain builds a pydantic schema from it and the
context holds service objects pydantic cannot validate; ``turn()`` restores the
type. Tool names are part of the activity-log contract (admin views and
release checks read them), so they do not change with the framework.
"""
from __future__ import annotations

from typing import Any, Awaitable, Callable

from langgraph.prebuilt import ToolRuntime

from utils.realtime_logger import ToolSpan
from workflow.context import TurnContext


def turn(runtime: ToolRuntime[Any]) -> TurnContext:
    return runtime.context


async def logged(context: TurnContext, name: str, args: dict[str, Any],
                 call: Callable[[], Awaitable[str]]) -> str:
    """Run a tool body inside an activity-log span (call, result, duration)."""
    async with ToolSpan(context.logger, name, args) as span:
        span.result = await call()
        return span.result
