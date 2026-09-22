"""Tools (data steps) the agents may call.

Tools receive the turn through ``ToolRuntime``; LangGraph's ``ToolNode``
injects it and keeps it out of the schema the model sees. The annotation is
``ToolRuntime[Any]`` because LangChain builds a pydantic schema from it and the
context holds service objects pydantic cannot validate; ``turn()`` restores the
type. Tool names are part of the activity-log contract (admin views and
release checks read them), so they do not change with the framework.
"""
from __future__ import annotations

import json
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


LINE_NUMBER_NOTE = ("Each content line starts with its line number as 'L12| '. The label is not part of the file: "
                    "in a CSV, the first field is what follows '| '. Cite file:line.")


def number_file_lines(result: str) -> str:
    """Prefix each line of a file read with its line number, so agents can cite file:line.

    Applies to screened JSON results that carry file ``content``. A page that
    starts mid-file is numbered from the backend's ``startLine``; without one
    the page is left unnumbered rather than numbered wrongly.
    """
    try:
        data = json.loads(result)
    except (TypeError, ValueError):
        return result
    if not isinstance(data, dict) or not isinstance(data.get("content"), str) or data.get("lineNumbers"):
        return result
    start = data.get("startLine") or (1 if not data.get("offset") else None)
    if not isinstance(start, int) or start < 1:
        return result
    lines = data["content"].split("\n")
    data["content"] = "\n".join(f"L{number}| {line}" for number, line in enumerate(lines, start))
    data["lineNumbers"] = LINE_NUMBER_NOTE
    return json.dumps(data, ensure_ascii=False)
