"""Requirements Analyst (LLM step + data steps over the user's repository).

Static context: analyst role, dbt rules. Dynamic context: the request, attached
files, conversation, the previous specification and existing drafts.
Outcome: a ``MigrationSpec`` — either ready for the authors or a set of blocking
questions for the user.
"""
from __future__ import annotations

import re
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


STALLED_NOTICE = ("I could not turn your answers into a build plan this time, so no model was generated. Ask me "
                  "to generate it again and I will use the answers you gave, including any placeholders or TBD "
                  "values you chose.")


def answered_questions(work: dict) -> list[str]:
    """The questions this chat is waiting on: the user's current message answers them."""
    spec = work.get("spec") or {}
    return list(spec.get("questions") or []) if not spec.get("ready") else []


def _words(text: str) -> set[str]:
    return {word for word in re.findall(r"[a-z0-9]+", text.lower()) if len(word) > 2}


def repeats(question: str, asked: list[str]) -> bool:
    """A question that is (nearly) one the user has just answered."""
    words = _words(question)
    for earlier in asked:
        other = _words(earlier)
        if words and other and len(words & other) / len(words | other) >= 0.6:
            return True
    return False


def settle(spec: MigrationSpec, asked: list[str]) -> MigrationSpec:
    """Once the user has answered, never re-ask: drop repeated questions and, with
    nothing new to ask, proceed. Answers such as 'placeholder', 'TBD' or 'no' are
    decisions, not gaps."""
    if asked:
        spec.questions = [question for question in spec.questions if not repeats(question, asked)]
        if not spec.questions:
            spec.ready = True
    return spec


def stalled(spec: MigrationSpec) -> bool:
    return not spec.targets and not spec.questions


def proceeds(spec: MigrationSpec) -> bool:
    return bool(spec.targets) and not spec.questions


def answered_nudge(asked: list[str], spec: MigrationSpec) -> str:
    held = ("you asked again:\n" + "\n".join(f"- {question}" for question in spec.questions)
            if spec.questions else "you returned no model to build.")
    return ("The current request is the user's reply to the questions you asked:\n"
            + "\n".join(f"{n}. {question}" for n, question in enumerate(asked, 1))
            + f"\nYet {held}\nWherever the reply answers a question, that question is settled: 'placeholder', "
              "'TBD', 'no', 'none' or 'either' are answers. Apply each answer only to the field or ref its "
              "question was about, list exactly the fields the user allowed as placeholder/TBD in placeholders, "
              "and record every answer in decisions. Then call submit_migration_spec with ready=true and the "
              "model file(s) in targets. Keep a question only if the reply genuinely leaves something new and "
              "blocking unresolved; never repeat or rephrase a question it answered.")


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
        asked = answered_questions(work)
        brief = self.brief(context, work)
        spec = settle(MigrationSpec.model_validate((await self.run(brief, context)).result), asked)
        if asked and not proceeds(spec):
            # The user replied to the questions, yet the plan neither builds
            # nor is settled: ask once more, pointing at their answers. Only a
            # question that survives this second look reaches the user.
            if context.logger:
                await context.logger.log("migration.analyst", "Answers received but no build plan; retrying once.",
                                         log_type="warning", data={"questions": len(asked),
                                                                   "stillAsking": len(spec.questions)})
            retry = [*brief, HumanMessage(answered_nudge(asked, spec))]
            spec = settle(MigrationSpec.model_validate((await self.run(retry, context)).result), asked)
            if stalled(spec):
                spec.findings = "\n\n".join(part for part in (spec.findings.strip(), STALLED_NOTICE) if part)
        # One file per name, and a bounded fan-out that is reported, not silent.
        unique = list({target.file_name: target for target in spec.targets}.values())
        spec.targets = unique[:MAX_TARGETS]
        work["skipped_targets"] = [target.file_name for target in unique[MAX_TARGETS:]]
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
        if asked := answered_questions(work):
            sections.append("## The current request answers the questions you asked\n"
                            + "\n".join(f"{n}. {question}" for n, question in enumerate(asked, 1))
                            + "\nPair each numbered answer with its question and record it in decisions. "
                              "'Placeholder', 'TBD', 'no' or 'none' are answers that let you proceed; apply each "
                              "only to the fields its question was about and list those fields in placeholders. "
                              "Do not ask these questions again.")
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
