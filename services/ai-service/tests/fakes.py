"""Test doubles for the agent runtime: scripted models, a recording gateway."""
from __future__ import annotations

import itertools
import json
from typing import Any, Callable, Union

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.utils.function_calling import convert_to_openai_tool
from pydantic import Field

from workflow.context import TurnContext, TurnRequest
from workflow.models import ModelRegistry, ModelRole

Reply = Union[AIMessage, str, Callable[[list[BaseMessage]], AIMessage]]
_ids = itertools.count()
USAGE = {"input_tokens": 11, "output_tokens": 7, "total_tokens": 18}


def call(name: str, **args: Any) -> AIMessage:
    """An assistant message that calls one tool (or submits one structured result)."""
    return AIMessage("", tool_calls=[{"name": name, "args": args, "id": f"call_{next(_ids)}", "type": "tool_call"}])


def calls(*pairs: tuple[str, dict]) -> AIMessage:
    return AIMessage("", tool_calls=[{"name": n, "args": a, "id": f"call_{next(_ids)}", "type": "tool_call"}
                                     for n, a in pairs])


class ScriptedChatModel(BaseChatModel):
    """Replies from a script, recording every request and the tools bound to it."""

    script: list = Field(default_factory=list)
    requests: list = Field(default_factory=list)
    fallback: Any = None     # reply used when the script is empty (e.g. a "safe" guard verdict)

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools, **kwargs):
        return self.bind(tools=[convert_to_openai_tool(tool) for tool in tools], **kwargs)

    def _generate(self, messages, stop=None, run_manager=None, **kwargs) -> ChatResult:
        self.requests.append({"messages": list(messages), "tools": [t["function"]["name"] for t in kwargs.get("tools", [])]})
        if not self.script and self.fallback is None:
            raise AssertionError(f"Unscripted model call; last message: {messages[-1].content!r:.200}")
        reply = self.script.pop(0) if self.script else self.fallback
        if callable(reply):
            reply = reply(list(messages))
        if isinstance(reply, str):
            reply = AIMessage(reply)
        reply = reply.model_copy(update={"usage_metadata": dict(USAGE)})
        return ChatResult(generations=[ChatGeneration(message=reply)])


class FakeProvider:
    name = "bedrock"
    model_name = "openai.gpt-oss-120b-1:0"


class FakeRegistry(ModelRegistry):
    """One scripted model per role; an unscripted role fails the test on use."""

    def __init__(self, **scripts: list[Reply]):
        super().__init__(FakeProvider())
        self.fakes = {role: ScriptedChatModel(script=list(scripts.get(role.value, []))) for role in ModelRole}
        # Every turn is screened by the Injection Guard; unless a test scripts
        # a verdict, it finds nothing.
        self.fakes[ModelRole.GUARD].fallback = lambda _: call("SafetyVerdict", manipulation=False,
                                                             category="none", evidence="")

    def get(self, role: ModelRole) -> ScriptedChatModel:
        return self.fakes[role]

    def script(self, role: str, *replies: Reply) -> None:
        self.fakes[ModelRole(role)].script.extend(replies)

    def requests(self, role: str) -> list:
        return self.fakes[ModelRole(role)].requests

    def total_calls(self) -> int:
        return sum(len(model.requests) for model in self.fakes.values())


class FakeGateway:
    """Records backend reads; replies come from per-operation handlers."""

    def __init__(self, **replies: Any):
        self.replies = replies
        self.requests: list[tuple[str, str, dict]] = []

    def _reply(self, kind: str, operation: str, args: dict) -> str:
        self.requests.append((kind, operation, args))
        value = self.replies.get(f"{kind}:{operation}", self.replies.get(kind, {"error": "not scripted"}))
        return value if isinstance(value, str) else json.dumps(value)

    async def github(self, operation, args):
        return self._reply("github", operation, args)

    async def chat_search(self, operation, args):
        return self._reply("chat_search", operation, args)

    async def impact_evidence(self, grant, source, operation, args):
        if grant.get("phase") != "confirmed" or source not in grant.get("sources", []):
            return json.dumps({"error": "This source has not been confirmed."})
        return self._reply(f"evidence:{source}", operation, args)


def turn_context(models: ModelRegistry, gateway=None, *, message: str = "hello", files=None, history=None,
                 impact: dict | None = None, session_id: str = "session-1", actor_id: str = "alice",
                 github_context=None, logger=None) -> TurnContext:
    return TurnContext(session_id=session_id, actor_id=actor_id, turn_id="turn-1",
                       request=TurnRequest(message=message, files=files or {}, history=history or [],
                                           github_context=github_context, impact_context=impact or {}),
                       gateway=gateway or FakeGateway(), models=models, logger=logger)


class RecordingLogger:
    """Stands in for RealtimeLogger; keeps every activity event in memory."""

    def __init__(self):
        self.events: list[dict[str, Any]] = []

    async def log(self, step, message, log_type="info", data=None, **fields):
        self.events.append({"step": step, "message": message, "type": log_type, "data": data, **fields})

    async def tool_call(self, name, args):
        self.events.append({"step": "tool.call", "tool": name, "args": args})

    async def tool_result(self, name, result, duration_ms, ok=True):
        self.events.append({"step": "tool.result", "tool": name, "result": result, "ok": ok})

    async def llm_call(self, **fields):
        self.events.append({"step": "llm.call", **fields})

    async def thinking(self, message):
        self.events.append({"step": "thinking", "message": message})

    async def guardrail(self, stage, decision, reasons, findings):
        self.events.append({"step": "guardrail", "stage": stage, "decision": decision, "reasons": list(reasons)})

    async def agent_output(self, text, duration_ms=None):
        self.events.append({"step": "agent.output", "output": text})

    async def complete(self, message="Processing complete"):
        self.events.append({"step": "complete"})

    async def close(self):
        pass

    def tools_called(self) -> list[str]:
        return [e["tool"] for e in self.events if e["step"] == "tool.call"]
