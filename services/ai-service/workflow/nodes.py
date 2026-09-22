"""Deterministic nodes of the turn graph: guardrails in and out, policy gate, dispatch, scope.

See ``workflow.security`` for how these map onto the guardrail layers.
"""
from __future__ import annotations

import json
from typing import Any, Literal

from langgraph.graph import END
from langgraph.runtime import Runtime
from langgraph.types import Command

import guardrails
from telemetry import record_guardrail_decision
from workflow.context import TurnContext
from workflow.security import harden_reply
from workflow.state import GuardrailVerdict, Route, TurnState

INTAKE = "screen_input"
OUTPUT = "screen_output"
OUT_OF_SCOPE_REPLY = ("I can only help with your data migration — share a mapping or template and tell me "
                      "what you'd like generated.")


async def screen_input(state: TurnState, runtime: Runtime[TurnContext]) -> Command[Literal["route_intent", "injection_guard", "__end__"]]:
    """Action step: the inbound policy boundary, before any model sees the turn.

    Sanitise, detect injection and deny-listed requests, detect PII, then block
    or redact. Only screened content reaches the workspace or the checkpoint.
    """
    context = runtime.context
    request = context.request
    if context.logger:
        await context.logger.thinking("Running guardrail checks...")
    screened = guardrails.screen_payload(request.message, request.files, request.history)
    inbound = guardrails.check_inbound(screened["message"], screened["files"])
    if screened["guardrail"]["decision"] in ("blocked", "redacted"):
        inbound.decision = screened["guardrail"]["decision"]
        inbound.reasons = screened["guardrail"]["reasons"]
    inbound.findings = {item["type"]: item["count"] for item in screened["guardrail"]["findings"]}
    inbound.data_class = screened["guardrail"]["data_class"]
    record_guardrail_decision(inbound.decision, stage="inbound")

    verdict = GuardrailVerdict(decision=inbound.decision, reasons=list(inbound.reasons),
                               findings=dict(inbound.findings), data_class=inbound.data_class)
    turn = {"turn_id": context.turn_id or "", "guardrail": verdict, "route": None, "safety": None,
            "response": "", "outputs": {}, "impact_action": None, "rerun": False, "message": ""}
    findings = [{"type": k, "count": v} for k, v in inbound.findings.items()]
    if inbound.decision == "blocked":
        if context.logger:
            await context.logger.guardrail("inbound", "blocked", inbound.reasons, findings)
        return Command(update={**turn, "response": guardrails.block_message(inbound.reasons)}, goto=END)
    if inbound.decision == "redacted" and context.logger:
        await context.logger.guardrail("inbound", "redacted", inbound.reasons, findings)

    workspace = context.workspace
    workspace.message = inbound.text
    workspace.files = dict(getattr(inbound, "redacted_files", screened["files"]) or {})
    workspace.history = screened["history"]
    impact_history = guardrails.screen_payload("", None, context.impact.get("history") or [])
    workspace.impact_history = impact_history["history"]
    if request.github_context:
        hint = guardrails.screen_payload(json.dumps(request.github_context, ensure_ascii=False))
        workspace.github_hint = hint["message"] if hint["guardrail"]["decision"] != "blocked" else ""
    if workspace.files and context.logger:
        await context.logger.thinking("Loading uploaded files...")
    # Routing and the model-based injection check run in parallel; policy_gate joins them.
    return Command(update={**turn, "message": inbound.text}, goto=["route_intent", "injection_guard"])


async def policy_gate(state: TurnState, runtime: Runtime[TurnContext]) -> Command[Literal["grant_judge", "dispatch", "__end__"]]:
    """Join of routing and the Injection Guard: block, re-check the grant, or dispatch."""
    context = runtime.context
    safety = state.get("safety") or {}
    if safety.get("manipulation"):
        reason = f"prompt_injection:{safety.get('category') or 'model_flagged'}"
        verdict = {**(state.get("guardrail") or {}), "decision": "blocked",
                   "reasons": [*((state.get("guardrail") or {}).get("reasons") or []), reason]}
        record_guardrail_decision("blocked", stage="inbound")
        if context.logger:
            await context.logger.guardrail("inbound", "blocked", [reason], [])
        return Command(update={"guardrail": verdict, "response": guardrails.block_message([reason])}, goto=END)
    route = state["route"]
    # A confirmed grant covers the analysis it was given for. Whether this turn
    # is still that analysis is the Grant Judge's decision, not the router's:
    # the judge sees the confirmed sources and the pending question, and a
    # message naming an unconfirmed source fails closed without a model call.
    recheck = (route["route"] == Route.IMPACT and context.impact_state.get("phase") == "confirmed"
               and not context.impact.get("just_confirmed"))
    return Command(goto="grant_judge" if recheck else "dispatch")


class Dispatcher:
    """Maps the routed intent to its specialist; the mapping is the registry's."""

    name = "dispatch"

    async def __call__(self, state: TurnState, runtime: Runtime[TurnContext]) -> dict[str, Any]:
        update: dict[str, Any] = {}
        if state["route"]["route"] != Route.IMPACT and runtime.context.impact_state:
            # Leaving an impact analysis: the backend clears its pending grant.
            update["impact_action"] = "clear"
        if state.get("pending") and state["pending"]["route"] != state["route"]["route"]:
            update["pending"] = None
        return update

    @staticmethod
    def select(state: TurnState) -> str:
        return state["route"]["route"]


async def scope_guard(state: TurnState, runtime: Runtime[TurnContext]) -> dict[str, Any]:
    """Action step: decline off-topic requests without spending a model call."""
    return {"response": OUT_OF_SCOPE_REPLY}


def after_specialist(state: TurnState) -> str:
    """A resumed user-input step hands the reply back to intake; otherwise finish."""
    return INTAKE if state.get("rerun") else OUTPUT


async def screen_output(state: TurnState, runtime: Runtime[TurnContext]) -> dict[str, Any]:
    """Action step: the outbound filter on the reply and every file.

    Redacts PII and secrets, removes content a markdown renderer would fetch
    on its own, and refuses a reply that leaks the system prompt.
    """
    context = runtime.context
    outbound = guardrails.check_outbound(state.get("response") or "")
    hardened = harden_reply(outbound.text)
    if hardened.reasons:
        outbound.decision, outbound.text = "redacted", hardened.text
        outbound.reasons = [*outbound.reasons, *hardened.reasons]
    record_guardrail_decision(outbound.decision, stage="outbound")
    if outbound.decision == "redacted" and context.logger:
        await context.logger.guardrail("outbound", "redacted", outbound.reasons,
                                       [{"type": k, "count": v} for k, v in outbound.findings.items()])
    outputs = {name: guardrails.check_outbound(content).text for name, content in (state.get("outputs") or {}).items()}
    inbound = state.get("guardrail") or {}
    findings = dict(inbound.get("findings") or {})
    for kind, count in outbound.findings.items():
        findings[kind] = findings.get(kind, 0) + count
    decision = "redacted" if "redacted" in (inbound.get("decision"), outbound.decision) else "allow"
    verdict = GuardrailVerdict(decision=decision, findings=findings, data_class=inbound.get("data_class", "metadata"),
                               reasons=list(dict.fromkeys([*(inbound.get("reasons") or []), *outbound.reasons])))
    return {"response": outbound.text, "outputs": outputs, "guardrail": verdict}
