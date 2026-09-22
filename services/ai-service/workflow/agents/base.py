"""The tool-calling agent loop, built from LangGraph primitives.

    START → model (LLM step) ─tool calls→ tools (ToolNode: data steps) → model …
                            ├─ no answer yet → nudge → model   (LLM-recoverable)
                            └─ answered ─────────────→ END

Agents that must return a typed result get one extra tool, ``submit_<schema>``,
whose arguments are the result: GPT-OSS on Bedrock cannot be forced to call a
tool, so the result is a tool call the model chooses to make, and a malformed
call comes back to it as a validation error it can fix.

The loop is compiled with ``checkpointer=False``: tool transcripts can hold
large file reads and are never written to a checkpoint.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Annotated, Any, Sequence, TypedDict

from langchain_core.messages import AIMessage, AnyMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_core.tools import BaseTool, StructuredTool
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode, ToolRuntime
from langgraph.runtime import Runtime
from langgraph.types import Command
from pydantic import BaseModel

from workflow.context import TurnContext
from workflow.models import ModelRole
from workflow.resilience import LLM_RETRY
from workflow.security import guard_tool_call
from workflow.structured import StructuredOutputError, invoke_structured


class LoopState(TypedDict, total=False):
    messages: Annotated[list[AnyMessage], add_messages]
    rounds: int
    nudges: int
    result: dict[str, Any] | None


@dataclass(frozen=True)
class ToolLoopSpec:
    name: str
    role: ModelRole
    tools: Sequence[BaseTool]
    output_schema: type[BaseModel] | None = None
    first_tool: str | None = None      # a tool the agent must start with
    max_rounds: int = 10


@dataclass
class LoopOutcome:
    messages: list[BaseMessage] = field(default_factory=list)
    result: dict[str, Any] | None = None

    @property
    def text(self) -> str:
        return final_text(self.messages)


def final_text(messages: Sequence[BaseMessage]) -> str:
    """The last assistant text, without reasoning blocks."""
    for message in reversed(messages):
        if isinstance(message, AIMessage) and not message.tool_calls:
            return message.text.strip()
    return ""


def clean_tool_name(name: str) -> str:
    """GPT-OSS can leave Harmony markers on a tool name (`lookup<|channel|>commentary`,
    `functions.lookup`); keep only the name itself."""
    name = name.split("<|", 1)[0].strip()
    return name[len("functions."):] if name.startswith("functions.") else name


def clean_tool_names(reply: AIMessage) -> AIMessage:
    if not reply.tool_calls:
        return reply
    calls = [{**call, "name": clean_tool_name(call["name"])} for call in reply.tool_calls]
    return reply if calls == reply.tool_calls else reply.model_copy(update={"tool_calls": calls})


def submit_tool(schema: type[BaseModel]) -> BaseTool:
    name = "submit_" + re.sub(r"(?<!^)(?=[A-Z])", "_", schema.__name__).lower()

    async def submit(runtime: ToolRuntime[Any], **fields: Any) -> Command:
        result = schema.model_validate(fields).model_dump(mode="json")
        return Command(update={"result": result, "messages": [
            ToolMessage("Result recorded.", tool_call_id=runtime.tool_call_id)]})

    return StructuredTool.from_function(
        coroutine=submit, name=name, args_schema=schema,
        description=f"Submit your final {schema.__name__} once you have finished using the other tools. "
                    "Call it exactly once, on its own.")


class ToolLoopAgent:
    MAX_NUDGES = 2

    def __init__(self, spec: ToolLoopSpec):
        self.spec = spec
        self._submit = submit_tool(spec.output_schema) if spec.output_schema else None
        self._tools = [*spec.tools, *([self._submit] if self._submit else [])]
        self.graph = self._build()

    def _build(self):
        builder = StateGraph(LoopState, context_schema=TurnContext)
        builder.add_node("model", self._model_step, retry_policy=LLM_RETRY)
        builder.add_node("tools", ToolNode(self._tools, awrap_tool_call=guard_tool_call))
        builder.add_node("nudge", self._nudge)
        builder.add_edge(START, "model")
        builder.add_conditional_edges("model", self._after_model, ["tools", "nudge", END])
        builder.add_conditional_edges("tools", self._after_tools, ["model", END])
        builder.add_edge("nudge", "model")
        return builder.compile(checkpointer=False, name=self.spec.name)

    async def run(self, messages: list[BaseMessage], context: TurnContext) -> LoopOutcome:
        final = await self.graph.ainvoke({"messages": messages, "rounds": 0, "nudges": 0, "result": None},
                                         context=context)
        outcome = LoopOutcome(messages=final["messages"], result=final.get("result"))
        if self.spec.output_schema and outcome.result is None:
            outcome.result = await self._extract(messages, outcome.text, context)
        return outcome

    async def _extract(self, brief: list[BaseMessage], reply: str, context: TurnContext) -> dict[str, Any]:
        """Last resort when the model kept answering in prose: record that prose as the result.

        Only the brief and the prose are sent — never the tool transcript — so
        the extraction call carries no tool history.
        """
        schema = self.spec.output_schema
        if not reply:
            raise StructuredOutputError(f"{self.spec.name} finished without submitting {schema.__name__}")
        result = await invoke_structured(context.models.get(self.spec.role), schema, [
            *brief, AIMessage(reply),
            HumanMessage(f"Record the reply above, unchanged in meaning, by calling `{schema.__name__}`. "
                         "Anything it asks the user belongs in the fields for open questions or missing information."),
        ])
        return result.model_dump(mode="json")

    # --- nodes -------------------------------------------------------------

    async def _model_step(self, state: LoopState, runtime: Runtime[TurnContext]) -> dict[str, Any]:
        model = runtime.context.models.get(self.spec.role).bind_tools(self._tools)
        messages = list(state["messages"])
        if state.get("rounds", 0) >= self.spec.max_rounds:
            # Budget spent: the instruction is shown for this call only.
            messages.append(HumanMessage(self._finish_instruction()))
        reply = clean_tool_names(await model.ainvoke(messages))
        return {"messages": [reply], "rounds": state.get("rounds", 0) + 1}

    def _nudge(self, state: LoopState) -> dict[str, Any]:
        return {"messages": [HumanMessage(self._nudge_instruction(state))], "nudges": state.get("nudges", 0) + 1}

    # --- edges -------------------------------------------------------------

    def _after_model(self, state: LoopState) -> str:
        last = state["messages"][-1]
        if isinstance(last, AIMessage) and last.tool_calls:
            # A model that keeps calling tools past its budget is stopped here.
            return "tools" if state.get("rounds", 0) <= self.spec.max_rounds + 1 else END
        if state.get("nudges", 0) < self.MAX_NUDGES and self._nudge_instruction(state):
            return "nudge"
        return END

    def _after_tools(self, state: LoopState) -> str:
        return END if state.get("result") is not None else "model"

    # --- instructions ------------------------------------------------------

    def _nudge_instruction(self, state: LoopState) -> str:
        used = {m.name for m in state["messages"] if isinstance(m, ToolMessage)}
        if self.spec.first_tool and self.spec.first_tool not in used:
            return f"Call `{self.spec.first_tool}` before answering."
        if self._submit and state.get("result") is None:
            return (f"Do not reply in text: calling `{self._submit.name}` is the only way to answer. Call it now, "
                    "even if information is missing — put your questions or missing inputs in its fields "
                    "(for example with ready=false).")
        if not self._submit and not final_text(state["messages"]):
            return "Reply to the user now with your answer."
        return ""

    def _finish_instruction(self) -> str:
        if self._submit:
            return f"Stop using tools. Call `{self._submit.name}` now with what you have established."
        return "Stop using tools. Answer the user now with what you have established."
