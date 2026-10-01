"""Service-authenticated bridge to the actual agent tools; no model invocation."""
import asyncio
import json
from typing import Any

from fastapi import APIRouter, HTTPException
from langchain_core.messages import AIMessage
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode
from pydantic import BaseModel, ConfigDict, Field, ValidationError

import guardrails
from routes.migration import agent_runtime
from workflow.catalog import TOOLS, agents_catalog, tools_catalog
from workflow.context import TurnContext, TurnRequest, TurnWorkspace
from workflow.gateway import HttpBackendGateway
from workflow.security import guard_tool_call

router = APIRouter()
slots = asyncio.Semaphore(8)


class ToolRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    session_id: str
    user_id: str
    turn_id: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    files: dict[str, str] = Field(default_factory=dict)
    impact_state: dict[str, Any] | None = None
    confirm: bool = False


@router.get("/agents")
async def agents():
    return {"agents": agents_catalog()}


@router.get("/tools")
async def tools():
    return {"tools": tools_catalog()}


def validate_arguments(name: str, arguments: dict[str, Any]):
    tool = TOOLS.get(name)
    if tool is None:
        raise HTTPException(404, "Unknown tool")
    schema = tool.tool_call_schema
    if set(arguments) - set(schema.model_fields):
        raise HTTPException(400, "Unknown tool arguments; identity and runtime cannot be supplied")
    try:
        return schema.model_validate(arguments, strict=True).model_dump()
    except ValidationError as error:
        # Never echo argument values (which may contain credentials).
        raise HTTPException(400, "Invalid tool arguments; consult the tool inputSchema") from error


async def execute_tool(name: str, arguments: dict, context: TurnContext, store=None):
    builder = StateGraph(MessagesState, context_schema=TurnContext)
    builder.add_node("tools", ToolNode([TOOLS[name]], awrap_tool_call=guard_tool_call))
    builder.add_edge(START, "tools")
    builder.add_edge("tools", END)
    graph = builder.compile(store=store, checkpointer=False)
    call = AIMessage("", tool_calls=[{"name": name, "args": arguments, "id": context.turn_id,
                                      "type": "tool_call"}])
    outcome = await graph.ainvoke({"messages": [call]}, context=context)
    message = outcome["messages"][-1]
    raw = message.content
    try:
        result = json.loads(raw)
    except (ValueError, TypeError):
        result = raw
    ok = message.status != "error" and not (isinstance(result, dict) and result.get("error"))
    return {"ok": bool(ok), "result": result}


@router.post("/tools/{name}/execute")
async def execute(name: str, request: ToolRequest):
    arguments = validate_arguments(name, request.arguments)
    if name in {"remember", "forget"} and not request.confirm:
        raise HTTPException(400, "Memory changes require confirm=true")
    if name == "read_impact_evidence":
        grant = request.impact_state or {}
        if grant.get("phase") != "confirmed" or arguments["source"] not in grant.get("sources", []):
            raise HTTPException(403, "Confirm this source through chat before reading evidence")
    # Inputs cross the same deterministic policy boundary as a chat turn.
    checked = guardrails.screen_payload("", {"arguments.json": json.dumps(arguments), **{
        f"attachment:{key}": value for key, value in request.files.items()}})
    if checked["guardrail"]["decision"] == "blocked":
        raise HTTPException(422, "Tool input was blocked by data policy")
    arguments = validate_arguments(name, json.loads(checked["files"]["arguments.json"]))
    runtime = agent_runtime()
    context = TurnContext(session_id=request.session_id, actor_id=request.user_id, turn_id=request.turn_id,
                          request=TurnRequest(message="", impact_context={"state": request.impact_state}),
                          gateway=HttpBackendGateway(request.session_id, request.user_id), models=runtime.runner.models,
                          workspace=TurnWorkspace(files={key: checked["files"][f"attachment:{key}"]
                                                         for key in request.files}))
    try:
        async with asyncio.timeout(120), slots:
            result = await execute_tool(name, arguments, context, runtime.store)
        return {**result, "guardrail": checked["guardrail"]}
    except TimeoutError as error:
        raise HTTPException(503, "Tool timed out; check the outcome before retrying a memory change") from error
    except Exception as error:
        raise HTTPException(503, "Tool execution unavailable") from error
