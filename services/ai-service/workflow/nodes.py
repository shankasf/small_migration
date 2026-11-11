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
from config import settings
from telemetry import record_guardrail_decision
from workflow.context import TurnContext
from workflow.memory import user_namespace
from workflow.security import harden_reply
from workflow.state import GuardrailVerdict, Route, TurnState

INTAKE = "screen_input"
OUTPUT = "screen_output"
OUT_OF_SCOPE_REPLY = ("I can only help with your data migration — share a mapping or template and tell me "
                      "what you'd like generated.")
FLAG_DESCRIPTIONS = {
    "instruction_override": "an attempt to change the assistant's rules or role",
    "prompt_extraction": "a request for the assistant's internal instructions",
    "credential_or_data_exfiltration": "a request for secrets, another user's data, or data sent to an outside URL",
    "confirmation_bypass": "an attempt to skip or fake the evidence-source confirmation",
    "hidden_instructions_in_data": "instructions addressed to the AI assistant",
}
GUARD_UNAVAILABLE_REPLY = ("⚠️ I couldn't run the safety check on this message just now, so I haven't processed it "
                           "(your message and files were not judged unsafe). Please send it again.")


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
            "response": "", "outputs": {}, "impact_action": None, "rerun": False, "message": "",
            # Kept for one turn so a follow-up like "give me that file" can be
            # read as continuing the last specialist rather than a new topic.
            "last_route": (state.get("route") or {}).get("route") or state.get("last_route")}
    findings = [{"type": k, "count": v} for k, v in inbound.findings.items()]
    if inbound.decision == "blocked":
        if context.logger:
            await context.logger.guardrail("inbound", "blocked", inbound.reasons, findings)
        return Command(update={**turn, "response": guardrails.block_message(inbound.reasons)}, goto=END)
    if inbound.decision == "redacted" and context.logger:
        await context.logger.guardrail("inbound", "redacted", inbound.reasons, findings)
    if screened.get("history_notices") and context.logger:
        # An earlier turn was left out or clipped (not the current one): the
        # turn proceeds, but the decision is recorded rather than silent.
        await context.logger.log(step="guardrail.history", message=(
            f"{len(screened['history_notices'])} earlier message(s) left out of or clipped in context"),
            data={"notices": screened["history_notices"]})

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
    # Routing, the model-based injection check, recall and summarisation all run
    # in parallel on the screened turn; policy_gate joins them.
    return Command(update={**turn, "message": inbound.text},
                   goto=["route_intent", "injection_guard", "recall_memories", "summarize_history"])


async def recall_memories(state: TurnState, runtime: Runtime[TurnContext]) -> dict[str, Any]:
    """Data step: this user's standing instructions that bear on the message.

    Nearest-neighbour search with a hard limit, so recall costs the same when
    the account holds twenty memories and when it holds twenty years of them.
    A store outage must not fail a turn: the assistant simply works without
    them, exactly as it did before anything was remembered.
    """
    context = runtime.context
    store = runtime.store
    if store is None or not context.actor_id or not context.workspace.message:
        return {}
    namespace = user_namespace(context.actor_id)
    limit = settings.MEMORY_RECALL_LIMIT
    try:
        # A listing costs a query; ranking costs an embedding. While a user holds
        # no more memories than fit in the prompt, every one of them applies and
        # there is nothing to rank — so most turns never embed anything, and the
        # cost only appears once an account has grown past that.
        items = await store.asearch(namespace, limit=limit + 1)
        if len(items) > limit:
            items = await store.asearch(namespace, query=context.workspace.message, limit=limit)
    except Exception as error:  # noqa: BLE001 - recall is best-effort by design
        print(json.dumps({"event": "memory.recall_failed", "error": type(error).__name__}), flush=True)
        return {}
    context.workspace.memories = [{"subject": str(item.value.get("subject", "")),
                                   "text": str(item.value.get("text", ""))}
                                  for item in items if item.value.get("text")]
    if context.workspace.memories and context.logger:
        await context.logger.log(step="memory.recall", message=f"{len(context.workspace.memories)} standing "
                                 "instruction(s) applied", data={"subjects": [m["subject"] for m in
                                                                              context.workspace.memories]})
    return {}


async def policy_gate(state: TurnState, runtime: Runtime[TurnContext]) -> Command[Literal["grant_judge", "dispatch", "__end__"]]:
    """Join of routing and the Injection Guard: block, re-check the grant, or dispatch."""
    context = runtime.context
    safety = state.get("safety") or {}
    if safety.get("manipulation"):
        # A classifier outage fails closed, but it is not an injection finding:
        # telling the user their files "match prompt-injection patterns" when
        # nothing was judged would be false.
        unavailable = safety.get("unavailable")
        category = safety.get("category")
        reason = ("safety_check_unavailable" if unavailable else
                  f"prompt_injection:{category if category and category != 'none' else 'model_flagged'}")
        verdict = {**(state.get("guardrail") or {}), "decision": "blocked",
                   "reasons": [*((state.get("guardrail") or {}).get("reasons") or []), reason]}
        record_guardrail_decision("blocked", stage="inbound")
        if context.logger:
            await context.logger.guardrail("inbound", "blocked", [reason], [])
        response = GUARD_UNAVAILABLE_REPLY if unavailable else guardrails.block_message([reason])
        if not unavailable:
            # Say where and what kind, so a false positive on a design document
            # is something the user can act on. Never echo the flagged text: it
            # is untrusted, and a blocked reply skips the outbound filters.
            where = ("an attached file" if category == "hidden_instructions_in_data" and context.workspace.files
                     else "your message or its attachments")
            response += (f" What was flagged: {FLAG_DESCRIPTIONS.get(category, 'a manipulation attempt')} in "
                         f"{where}. If that is ordinary migration content, rephrase it or remove that passage "
                         "and send it again.")
        return Command(update={"guardrail": verdict, "response": response}, goto=END)
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
    """A resumed user-input step hands the reply back to intake; otherwise finish.

    A completed turn passes through ``capture_memory`` on its way out, so a
    standing instruction is recorded whether or not the specialist called the tool.
    """
    return INTAKE if state.get("rerun") else "capture_memory"


async def screen_output(state: TurnState, runtime: Runtime[TurnContext]) -> dict[str, Any]:
    """Action step: the outbound filter on the reply and every file.

    Redacts PII and secrets, removes content a markdown renderer would fetch
    on its own, and refuses a reply that leaks the system prompt.
    """
    context = runtime.context
    outbound = guardrails.check_outbound(state.get("response") or "")
    outbound.text = guardrails.disclose_truncation(outbound.text, outbound)
    hardened = harden_reply(outbound.text)
    if hardened.reasons:
        outbound.decision, outbound.text = "redacted", hardened.text
        outbound.reasons = [*outbound.reasons, *hardened.reasons]
    record_guardrail_decision(outbound.decision, stage="outbound")
    if outbound.decision == "redacted" and context.logger:
        await context.logger.guardrail("outbound", "redacted", outbound.reasons,
                                       [{"type": k, "count": v} for k, v in outbound.findings.items()])
    # Generated files cross the same filter. When it changes one (a value that
    # looks like a phone or IRD number becomes [PHONE_REDACTED], or an oversized
    # file is cut), the user must be told: a file that silently differs from
    # what the reply describes is a deliverable that claims to be complete and is not.
    outputs, altered, output_findings = {}, [], {}
    for name, content in (state.get("outputs") or {}).items():
        checked = guardrails.check_outbound(content)
        outputs[name] = checked.text
        cut = len(content) > settings.MAX_INPUT_CHARS
        if checked.findings or cut:
            altered.append(f"`{name}`" + (" (cut at {:,} characters)".format(settings.MAX_INPUT_CHARS) if cut else ""))
        for kind, count in checked.findings.items():
            output_findings[kind] = output_findings.get(kind, 0) + count
    response = outbound.text
    output_reasons = []
    if altered:
        output_reasons = ["output_file_altered"]
        response = (f"{response}\n\nNote: the security filter changed {', '.join(altered)} before delivery — "
                    "values that look like personal data or secrets were replaced with `[..._REDACTED]` markers"
                    ", or the file was cut where noted. Review those files before using them.").strip()
        if context.logger:
            await context.logger.guardrail("outbound", "redacted", output_reasons,
                                           [{"type": k, "count": v} for k, v in output_findings.items()])
    inbound = state.get("guardrail") or {}
    findings = dict(inbound.get("findings") or {})
    for kind, count in [*outbound.findings.items(), *output_findings.items()]:
        findings[kind] = findings.get(kind, 0) + count
    decision = "redacted" if altered or "redacted" in (inbound.get("decision"), outbound.decision) else "allow"
    verdict = GuardrailVerdict(decision=decision, findings=findings, data_class=inbound.get("data_class", "metadata"),
                               reasons=list(dict.fromkeys([*(inbound.get("reasons") or []), *outbound.reasons,
                                                           *output_reasons])))
    return {"response": response, "outputs": outputs, "guardrail": verdict}
