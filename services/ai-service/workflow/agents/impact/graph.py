"""Impact subgraph.

    START → plan_sources (data) ─not covered→ ask_sources (user input: interrupt)
                                └ confirmed ─→ investigate (LLM+data) → evidence_gate (data)
                                               evidence_gate ─grounded→ report (LLM) → finish (action) → END
                                                             ├ nothing read yet → investigate (once)
                                                             └ ungrounded/missing ──→ finish

The Evidence Investigator and Impact Reporter together are the "Impact Analysis
Agent" in the activity log: one ``impact_analysis_agent`` call spans both.
"""
from __future__ import annotations

import json
import re
import time
from typing import Annotated, Any, Literal, TypedDict

from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime
from langgraph.types import Command

from workflow.agents.base import ToolLoopAgent, ToolLoopSpec
from workflow.agents.formatting import as_json
from workflow.agents.impact.schemas import EvidenceDossier, ImpactReport
from workflow.agents.impact.sources import ask_sources, plan_sources
from workflow.context import TurnContext
from workflow.models import ModelRole
from workflow.prompts import prompt
from workflow.resilience import LLM_RETRY
from workflow.state import ImpactWork, PendingInput, RouteDecision, latest
from workflow.structured import invoke_structured
from workflow.tools.evidence import EVIDENCE_TOOLS, is_substantive_read

AGENT_SPAN = "impact_analysis_agent"
UNVERIFIED = ("I could not verify a dbt reference from your selected sources. Please identify the target asset "
              "and change, and provide an accessible SQL/YAML file, manifest/catalog artifact, repository path, "
              "or dbt run. I cannot confirm lineage without evidence.")
REREAD = ("You concluded without reading any of the confirmed evidence. Before deciding anything is missing, "
          "call read_impact_evidence with operation 'list' for each confirmed source, then read the relevant "
          "items by the ids it returns (for example the uploaded manifest.json), and only then submit.")
PASTED_REFERENCE = re.compile(r"```(?:sql|ya?ml|json)\s*\n[\s\S]+?```", re.IGNORECASE)


class ImpactState(TypedDict, total=False):
    # Shared with the turn graph.
    route: RouteDecision | None
    impact: Annotated[ImpactWork, latest]
    pending: Annotated[PendingInput | None, latest]
    response: Annotated[str, latest]
    impact_action: Annotated[str | None, latest]
    rerun: Annotated[bool, latest]
    # Private to this subgraph.
    dossier: dict[str, Any]
    evidence_reads: int
    started: float
    reread: bool          # the investigator was already sent back once to read evidence


def count_substantive_reads(messages: list) -> int:
    """Evidence reads that returned artefact content, from the raw transcript."""
    operations = {call["id"]: call["args"].get("operation", "")
                  for message in messages if isinstance(message, AIMessage) for call in message.tool_calls
                  if call["name"] == "read_impact_evidence"}
    return sum(1 for message in messages
               if isinstance(message, ToolMessage) and message.tool_call_id in operations
               and is_substantive_read(operations[message.tool_call_id], message.text))


def analysis_brief(context: TurnContext) -> dict[str, Any]:
    """Server-owned brief: the model cannot inject a confirmation or replace the request."""
    grant = context.impact_state
    return {"request": grant.get("request", ""), "confirmed_sources": grant.get("sources", []),
            "conversation": context.workspace.impact_history, "latest_user_message": context.workspace.message}


class EvidenceInvestigator(ToolLoopAgent):
    name = "investigate"

    def __init__(self) -> None:
        super().__init__(ToolLoopSpec(name="evidence_investigator", role=ModelRole.INVESTIGATOR,
                                      tools=EVIDENCE_TOOLS, output_schema=EvidenceDossier, max_rounds=24))

    async def __call__(self, state: ImpactState, runtime: Runtime[TurnContext]) -> Command[Literal["evidence_gate"]]:
        context = runtime.context
        started = state.get("started") or time.monotonic()
        if context.logger and not state.get("reread"):
            await context.logger.tool_call(AGENT_SPAN, {"agent": "Impact Analysis Agent"})
            await context.logger.thinking("Reading the evidence sources you confirmed...")
        messages = [SystemMessage(prompt("impact_analysis", "investigator")),
                    HumanMessage(json.dumps(analysis_brief(context), ensure_ascii=False))]
        if state.get("reread"):
            messages.append(HumanMessage(REREAD))
        outcome = await self.run(messages, context)
        reads = count_substantive_reads(outcome.messages) + (state.get("evidence_reads") or 0)
        return Command(update={"dossier": outcome.result, "evidence_reads": reads, "started": started,
                               "impact": {**(state.get("impact") or {}), "evidence_reads": reads}},
                       goto="evidence_gate")


def evidence_gate(state: ImpactState, runtime: Runtime[TurnContext]) -> Command[Literal["investigate", "report", "finish"]]:
    """Data step: a report must rest on evidence the investigator actually read.

    An investigator that concluded without reading anything is sent back once
    (LLM-recoverable); after that, what it could not establish is the answer.
    """
    dossier = state["dossier"]
    grounded = bool(state["evidence_reads"]) or pasted_reference(runtime.context)
    if not grounded and not state.get("reread"):
        return Command(update={"reread": True}, goto="investigate")
    if not dossier["ready"]:
        return Command(update={"response": dossier["missing_information"].strip() or UNVERIFIED}, goto="finish")
    if not grounded:
        return Command(update={"response": UNVERIFIED}, goto="finish")
    return Command(goto="report")


def pasted_reference(context: TurnContext) -> bool:
    """References pasted as code in the brief count as evidence for the uploads source."""
    if "uploads" not in context.impact_state.get("sources", []):
        return False
    text = "\n".join([context.impact_state.get("request", ""), context.workspace.message,
                      *(m["content"] for m in context.workspace.impact_history if m["role"] == "user")])
    return bool(PASTED_REFERENCE.search(text))


class ImpactReporter:
    name = "report"

    async def __call__(self, state: ImpactState, runtime: Runtime[TurnContext]) -> Command[Literal["finish"]]:
        context = runtime.context
        if context.logger:
            await context.logger.thinking("Writing up the impact analysis...")
        report = await invoke_structured(context.models.get(ModelRole.REPORTER), ImpactReport, [
            SystemMessage(prompt("impact_analysis", "reporter")),
            HumanMessage(f"## Analysis brief\n{as_json(analysis_brief(context))}\n\n"
                         f"## Evidence dossier\n{as_json(state['dossier'])}"),
        ])
        return Command(update={"response": report.markdown()}, goto="finish")


async def finish(state: ImpactState, runtime: Runtime[TurnContext]) -> dict[str, Any]:
    """Action step: close the Impact Analysis Agent span in the activity log."""
    logger = runtime.context.logger
    if logger:
        elapsed = int((time.monotonic() - state.get("started", time.monotonic())) * 1000)
        await logger.tool_result(AGENT_SPAN, state.get("response", ""), elapsed, ok=True)
    return {}


def build_impact_graph():
    builder = StateGraph(ImpactState, context_schema=TurnContext)
    builder.add_node("plan_sources", plan_sources)
    builder.add_node("ask_sources", ask_sources)
    builder.add_node(EvidenceInvestigator.name, EvidenceInvestigator())
    builder.add_node("evidence_gate", evidence_gate)
    builder.add_node(ImpactReporter.name, ImpactReporter(), retry_policy=LLM_RETRY)
    builder.add_node("finish", finish)
    builder.add_edge(START, "plan_sources")
    builder.add_edge("ask_sources", END)
    builder.add_edge("finish", END)
    return builder.compile(name="impact")
