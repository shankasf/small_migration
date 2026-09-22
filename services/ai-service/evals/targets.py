"""Evaluation targets: the real agents, the real graph, synthetic backend data.

Node-level targets (single-step evals) run the production intake node first, so
an input the rule-based guardrails block is scored as blocked, exactly as in a
chat turn. Conversation targets run whole turns through ``TurnRunner`` on the
compiled turn graph, one fresh thread per case, including pauses and resumes.
"""
from __future__ import annotations

import uuid
from functools import lru_cache
from typing import Any

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.store.memory import InMemoryStore
from langgraph.graph import END
from langgraph.runtime import Runtime

import guardrails
from evals.fixtures import resolve
from evals.gateway import EvalGateway
from evals.recorder import ActivityRecorder
from workflow.agents.grant_judge import GrantJudgeAgent
from workflow.agents.injection_guard import InjectionGuard
from workflow.agents.router import RouterAgent
from workflow.context import TurnContext, TurnRequest
from workflow.models import ModelRegistry, default_registry
from workflow.nodes import screen_input
from workflow.orchestrator import build_turn_graph
from workflow.runner import TurnRunner
from workflow.security import harden_reply
from workflow.tracing import TraceExporter

ACTOR = "eval-user"
PREVIOUS = "@previous_response"


@lru_cache(maxsize=1)
def registry() -> ModelRegistry:
    return default_registry()


def request_from(turn: dict[str, Any]) -> TurnRequest:
    return TurnRequest(message=turn["message"], files=turn.get("files") or {}, history=turn.get("history") or [],
                       github_context=turn.get("github_context"), impact_context=turn.get("impact_context") or {})


async def screened_context(inputs: dict[str, Any]) -> tuple[TurnContext, dict[str, Any] | None]:
    """A turn context after the production intake node; the verdict when intake blocks."""
    inputs = resolve(inputs)
    context = TurnContext(session_id=f"eval-{uuid.uuid4().hex[:12]}", actor_id=ACTOR, turn_id="eval",
                          request=request_from(inputs), gateway=EvalGateway(inputs.get("backend")),
                          models=registry(), logger=ActivityRecorder())
    command = await screen_input({}, Runtime(context=context))
    return context, (command.update["guardrail"] if command.goto == END else None)


# --- single-step targets ---------------------------------------------------

async def router_target(inputs: dict[str, Any]) -> dict[str, Any]:
    context, blocked = await screened_context(inputs)
    if blocked:
        return {"route": "blocked", "new_analysis": False, "guardrail": blocked}
    update = await RouterAgent()({"pending": inputs.get("pending")}, Runtime(context=context))
    return dict(update["route"])


async def guard_target(inputs: dict[str, Any]) -> dict[str, Any]:
    """Layered verdict: rules (intake) first, then the model-based Injection Guard."""
    context, blocked = await screened_context(inputs)
    if blocked:
        return {"flagged": True, "layer": "rules", "category": ",".join(blocked.get("reasons") or [])}
    verdict = (await InjectionGuard()({}, Runtime(context=context)))["safety"]
    return {"flagged": verdict["manipulation"], "layer": "model" if verdict["manipulation"] else "none",
            "category": verdict["category"], "evidence": verdict["evidence"]}


async def grant_judge_target(inputs: dict[str, Any]) -> dict[str, Any]:
    grant = {"id": "analysis-eval", "userId": ACTOR, "phase": "confirmed", "request": inputs["confirmed_request"],
             "sources": inputs.get("sources") or ["uploads"], "startedAt": "2026-09-01T00:00:00Z"}
    context, blocked = await screened_context({**inputs, "impact_context": {"state": grant}})
    if blocked:
        return {"continues": None, "blocked": True}
    pending = ({"kind": "impact_question", "question": inputs["pending_question"], "route": "impact"}
               if inputs.get("pending_question") else None)
    command = await GrantJudgeAgent()({"route": {"route": "impact", "new_analysis": False}, "pending": pending},
                                      Runtime(context=context))
    return {"continues": not command.update["route"]["new_analysis"]}


# --- whole-conversation target ---------------------------------------------

_gateways: dict[str, EvalGateway] = {}


@lru_cache(maxsize=1)
def turn_runner() -> TurnRunner:
    # Compiled once and shared, as in production; each case is its own thread.
    # Long-term memory is in-process here: no embeddings, no AWS, and every case
    # starts from an empty store, so a case must write what it later recalls.
    graph = build_turn_graph(InMemorySaver(), store=InMemoryStore())
    return TurnRunner(graph, registry(), TraceExporter(), gateway_factory=lambda session, actor: _gateways[session])


def _fill(value: Any, responses: list[str]) -> Any:
    """Substitute earlier replies: ``@previous_response`` or ``@response:N`` (turn N, 1-based)."""
    if value == PREVIOUS:
        return responses[-1] if responses else ""
    if isinstance(value, str) and value.startswith("@response:"):
        return responses[int(value.split(":", 1)[1]) - 1]
    if isinstance(value, dict):
        return {key: _fill(item, responses) for key, item in value.items()}
    if isinstance(value, list):
        return [_fill(item, responses) for item in value]
    return value


async def conversation_target(inputs: dict[str, Any]) -> dict[str, Any]:
    inputs = resolve(inputs)
    session = f"eval-{uuid.uuid4().hex[:16]}"
    # One store is shared by the compiled graph, so each case gets its own user:
    # what one case remembers must not reach the next.
    actor = f"{ACTOR}-{session}"
    runner = turn_runner()
    recorder = ActivityRecorder()
    _gateways[session] = EvalGateway(inputs.get("backend"))
    turns: list[dict[str, Any]] = []
    responses: list[str] = []
    # The backend sends the saved conversation with every turn, so a case's
    # earlier turns must reach the agents the same way here.
    conversation: list[dict[str, str]] = []
    try:
        for number, turn in enumerate(inputs["turns"], 1):
            filled = _fill(turn, responses)
            filled = {**filled, "history": [*conversation, *(filled.get("history") or [])]}
            result = await runner.run(request_from(filled), session_id=session, actor_id=actor,
                                      turn_id=f"turn-{number}", logger=recorder)
            # The HTTP layer's final outbound pass (routes/migration.py) applies to every reply.
            response = harden_reply(guardrails.check_outbound(result.response).text).text
            responses.append(response)
            conversation += [{"role": "user", "content": filled["message"]},
                             {"role": "assistant", "content": response}]
            turns.append({"response": response, "files": result.files, "paused": result.paused,
                          "impact_action": result.impact_action, "route": result.route,
                          "guardrail": result.guardrail.get("decision", "allow"),
                          "input_tokens": result.input_tokens, "output_tokens": result.output_tokens})
    finally:
        _gateways.pop(session, None)
        await runner.forget(session)
    last = turns[-1]
    return {"turns": turns, "response": last["response"], "files": last["files"], "paused": last["paused"],
            "route": last["route"], "tool_calls": recorder.tool_calls(),
            "input_tokens": sum(t["input_tokens"] for t in turns),
            "output_tokens": sum(t["output_tokens"] for t in turns)}
