"""Requirements Analyst (LLM step + data steps over the user's repository).

Static context: analyst role, dbt rules. Dynamic context: the request, attached
files, conversation, the previous specification and existing drafts.
Outcome: a ``MigrationSpec`` — either ready for the authors or a set of blocking
questions for the user.
"""
from __future__ import annotations

from typing import Literal

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.runtime import Runtime
from langgraph.types import Command

from workflow.agents.base import ToolLoopAgent, ToolLoopSpec
from workflow.agents.formatting import as_json, files_block, history_messages, memory_notes
from workflow.agents.migration.schemas import MigrationSpec
from workflow.context import TurnContext
from workflow.models import ModelRole
from workflow.prompts import prompt
from workflow.state import PendingInput, Route
from workflow.tools.github import GITHUB_TOOLS

MAX_TARGETS = 6


def clarification(spec: MigrationSpec) -> str:
    questions = spec.questions or ["What is missing or unclear in the mapping or template for this model?"]
    intro = [spec.findings.strip(), ""] if spec.findings.strip() else []
    return "\n".join([*intro, "Before I generate the model, I need you to confirm:",
                      *(f"{n}. {question.strip()}" for n, question in enumerate(questions, 1))])


class RequirementsAnalyst(ToolLoopAgent):
    name = "analyze"

    def __init__(self) -> None:
        super().__init__(ToolLoopSpec(name="requirements_analyst", role=ModelRole.ANALYST, tools=GITHUB_TOOLS,
                                      output_schema=MigrationSpec, max_rounds=8))

    async def __call__(self, state: dict, runtime: Runtime[TurnContext]) -> Command[Literal["clarify", "plan_builds", "publish"]]:
        context = runtime.context
        if context.logger:
            await context.logger.thinking("Analysing your mapping, template and reference models...")
        work = dict(state.get("migration") or {})
        outcome = await self.run(self.brief(context, work), context)
        spec = MigrationSpec.model_validate(outcome.result)
        # One file per name, and a bounded fan-out.
        unique = {target.file_name: target for target in spec.targets}
        spec.targets = list(unique.values())[:MAX_TARGETS]
        work["spec"] = spec.model_dump()

        if spec.questions or not spec.ready:
            pending = PendingInput(kind="clarification", question=clarification(spec), route=Route.GENERATE.value)
            return Command(update={"migration": work, "pending": pending}, goto="clarify")
        if not spec.targets:
            return Command(update={"migration": work}, goto="publish")
        return Command(update={"migration": work}, goto="plan_builds")

    def brief(self, context: TurnContext, work: dict) -> list:
        workspace = context.workspace
        sections = [f"## Current request\n{workspace.message}", files_block(workspace.files)]
        if work.get("spec") and (not work["spec"].get("ready") or work.get("drafts")):
            sections.append("## Your previous specification for this chat (update it; do not re-ask answered "
                            f"questions)\n{as_json(work['spec'])}")
        elif work.get("spec"):
            sections.append("## Retry after unsuccessful generation\nThe earlier plan produced no saved model. "
                            "Rebuild the specification from the original user-supplied SQL and confirmed "
                            "decisions in the conversation. Do not carry forward assumptions from the failed plan.")
        if work.get("drafts"):
            sections.append("## Model files already generated in this chat\n" + ", ".join(sorted(work["drafts"])))
        system = "\n\n".join([prompt("analyst", "dbt_rules"), *memory_notes(context)])
        if workspace.github_hint:
            system += ("\n\nGitHub connection metadata (verify with tools before relying on it): "
                       + workspace.github_hint)
        return [SystemMessage(system), *history_messages(workspace.history), HumanMessage("\n\n".join(sections))]
